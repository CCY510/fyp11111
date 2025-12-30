let map, service, geocoder, directionsRenderer, directionsService, infoWindow;
let startPos = null;
let startMarker = null; 
let markers = [];
let activeRegion = 'kowloon';
let activeType = 'all';
let activeMode = 'DRIVING';
let startAddressName = "目前位置";

const REGIONS = {
    'hong kong island': {
        center: {lat: 22.28, lng: 114.17}, label: '港島',
        bounds: { sw: {lat: 22.18, lng: 114.08}, ne: {lat: 22.31, lng: 114.28} }
    },
    'kowloon': {
        center: {lat: 22.32, lng: 114.17}, label: '九龍',
        bounds: { sw: {lat: 22.28, lng: 114.10}, ne: {lat: 22.36, lng: 114.28} }
    },
    'new territories': {
        center: {lat: 22.40, lng: 114.10}, label: '新界',
        bounds: { sw: {lat: 22.32, lng: 113.80}, ne: {lat: 22.56, lng: 114.50} }
    }
};

const TYPE_QUERIES = {
    'all': 'hospital|clinic|醫院|診所',
    'hospital': 'hospital 醫院',
    'clinic': 'medical clinic 診所',
    'ae': 'accident and emergency hospital 急症室'
};

function initMap() {
    map = new google.maps.Map(document.getElementById("map-canvas"), {
        center: { lat: 22.32, lng: 114.17 },
        zoom: 13,
        mapTypeControl: false,
        clickableIcons: false
    });

    service = new google.maps.places.PlacesService(map);
    geocoder = new google.maps.Geocoder();
    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({ map: map });
    infoWindow = new google.maps.InfoWindow();

    // 起點 AutoComplete
    const startInput = document.getElementById("start-input");
    const startAuto = new google.maps.places.Autocomplete(startInput, { componentRestrictions: { country: "hk" } });
    startAuto.addListener("place_changed", () => {
        const place = startAuto.getPlace();
        if (place.geometry) {
            startAddressName = place.name || place.formatted_address;
            handleNewStart(place.geometry.location, startAddressName);
        }
    });

    // 終點 AutoComplete
    const destInput = document.getElementById("dest-input");
    const destAuto = new google.maps.places.Autocomplete(destInput, { componentRestrictions: { country: "hk" } });
    destAuto.addListener("place_changed", () => {
        const place = destAuto.getPlace();
        if (place.geometry && startPos) {
            calculateRoute(place.geometry.location);
        }
    });

    // 地圖點擊確認視窗
    map.addListener("click", (e) => {
        const latLng = e.latLng;
        geocoder.geocode({ location: latLng }, (results, status) => {
            const addr = (status === "OK") ? results[0].formatted_address : "選定位置";
            infoWindow.setContent(`
                <div style="padding:10px;">
                    <div style="margin-bottom:8px;font-size:13px;">${addr}</div>
                    <button class="info-btn" id="set-origin-btn">📍 設為起點並搜尋</button>
                </div>`);
            infoWindow.setPosition(latLng);
            infoWindow.open(map);
            
            google.maps.event.addListenerOnce(infoWindow, 'domready', () => {
                document.getElementById('set-origin-btn').onclick = () => {
                    document.getElementById("start-input").value = addr;
                    handleNewStart(latLng, addr);
                    infoWindow.close();
                };
            });
        });
    });

    bindEvents();
    tryGPS();
}

function handleNewStart(location, addrName) {
    startPos = location;
    startAddressName = addrName || "地圖位置";
    
    // 解決重複起點問題
    if (startMarker) startMarker.setMap(null);
    startMarker = new google.maps.Marker({
        position: location, map: map, zIndex: 999,
        label: "起點",
        icon: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"
    });

    // 自動偵測區域
    for (const key in REGIONS) {
        const b = REGIONS[key].bounds;
        if (location.lat() >= b.sw.lat && location.lat() <= b.ne.lat &&
            location.lng() >= b.sw.lng && location.lng() <= b.ne.lng) {
            activeRegion = key;
            updateUISelection("#region-btns", key);
            break;
        }
    }
    map.panTo(location);
    searchMedical(false);
}

function bindEvents() {
    document.getElementById("gps-btn").onclick = tryGPS;

    // 區域切換邏輯 (保留原有的跨區確認功能)
    document.querySelectorAll(`#region-btns button`).forEach(btn => {
        btn.onclick = (e) => {
            const targetKey = e.currentTarget.dataset.region;
            const regionInfo = REGIONS[targetKey];
            if (startPos) {
                const b = regionInfo.bounds;
                const isInside = (startPos.lat() >= b.sw.lat && startPos.lat() <= b.ne.lat &&
                                  startPos.lng() >= b.sw.lng && startPos.lng() <= b.ne.lng);
                if (!isInside) {
                    if (confirm(`目前起點不在「${regionInfo.label}」，是否要將起點移動至該區中心？`)) {
                        const newLoc = new google.maps.LatLng(regionInfo.center.lat, regionInfo.center.lng);
                        document.getElementById("start-input").value = `${regionInfo.label}中心`;
                        handleNewStart(newLoc, `${regionInfo.label}中心`);
                        return;
                    } else {
                        activeRegion = targetKey;
                        updateUISelection("#region-btns", targetKey);
                        map.panTo(regionInfo.center);
                        searchMedical(true);
                        return;
                    }
                }
            }
            activeRegion = targetKey;
            updateUISelection("#region-btns", targetKey);
            map.panTo(regionInfo.center);
            searchMedical(false);
        };
    });

    // 類型與模式切換
    const bindSimple = (id, callback) => {
        document.querySelectorAll(`${id} button`).forEach(btn => {
            btn.onclick = (e) => {
                const val = e.currentTarget.dataset.type || e.currentTarget.dataset.mode;
                updateUISelection(id, val);
                callback(val);
                searchMedical(false);
            };
        });
    };
    bindSimple("#type-btns", (v) => activeType = v);
    bindSimple("#mode-btns", (v) => activeMode = v);
}

function searchMedical(isCrossRegion) {
    if (!startPos) return;
    clearMarkers();
    document.getElementById("place-list").innerHTML = "<li>搜尋中...</li>";

    // 醫院搜尋優化：改用 textSearch 避免 nearbySearch 遺漏大型醫院
    const searchCenter = isCrossRegion ? REGIONS[activeRegion].center : startPos;
    
    const request = {
        location: searchCenter,
        radius: 8000,
        query: TYPE_QUERIES[activeType],
        language: 'zh-HK'
    };

    service.textSearch(request, (results, status) => {
        if (status === "OK") {
            fetchDistances(results, isCrossRegion);
        } else {
            document.getElementById("place-list").innerHTML = "<li>無結果</li>";
        }
    });
}

function fetchDistances(places, isCrossRegion) {
    const matrixService = new google.maps.DistanceMatrixService();
    matrixService.getDistanceMatrix({
        origins: [startPos],
        destinations: places.map(p => p.geometry.location),
        travelMode: google.maps.TravelMode[activeMode],
    }, (response, status) => {
        if (status === "OK") renderList(places, response.rows[0].elements, isCrossRegion);
        else renderBasicList(places, status);
    });
}

function renderList(places, distanceData, isCrossRegion) {
    const listUI = document.getElementById("place-list");
    listUI.innerHTML = "";
    
    const combined = places.map((p, i) => ({ ...p, data: distanceData[i] }))
        .filter(item => item.data && item.data.status === "OK")
        .sort((a, b) => a.data.distance.value - b.data.distance.value);

    combined.forEach(item => createListItem(item, item.data.distance.text, item.data.duration.text));

    const statusEl = document.getElementById("status");
    const targetName = REGIONS[activeRegion].label;
    if (isCrossRegion) {
        statusEl.innerText = `從 [${startAddressName}] 跨區至 [${targetName}]`;
        statusEl.style.color = "#fbbf24";
    } else {
        statusEl.innerText = `起點：${startAddressName} (${targetName})`;
        statusEl.style.color = "white";
    }
}

function createListItem(item, dist, time) {
    const listUI = document.getElementById("place-list");
    const li = document.createElement("li");
    li.className = "place-item";
    
    const extUrl = `https://www.google.com/maps/dir/?api=1&origin=${startPos.lat()},${startPos.lng()}&destination=${encodeURIComponent(item.name)}&travelmode=${activeMode.toLowerCase()}`;

    li.innerHTML = `
        <div class="place-info">
            <span class="place-name">${item.name}</span>
            <div class="place-meta">📍 ${dist} | ⏱️ ${time}</div>
        </div>
        <div class="nav-button-group">
            <button class="mini-nav-btn internal-btn">導航</button>
            <button class="mini-nav-btn external-btn">外部</button>
        </div>
    `;

    li.querySelector('.internal-btn').onclick = (e) => { 
        e.stopPropagation(); 
        calculateRoute(item.geometry.location); 
        map.panTo(item.geometry.location);
        map.setZoom(16);
    };
    li.querySelector('.external-btn').onclick = (e) => { e.stopPropagation(); window.open(extUrl, '_blank'); };
    li.onclick = () => {
        map.panTo(item.geometry.location);
        map.setZoom(15);
    };

    listUI.appendChild(li);
    markers.push(new google.maps.Marker({ position: item.geometry.location, map: map, title: item.name }));
}

function calculateRoute(dest) {
    directionsService.route({
        origin: startPos, destination: dest, travelMode: google.maps.TravelMode[activeMode]
    }, (res, status) => { if (status === "OK") directionsRenderer.setDirections(res); });
}

function tryGPS() {
    document.getElementById("status").innerText = "正在定位...";
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const loc = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
                handleNewStart(loc, "我的位置");
            },
            (err) => { 
                document.getElementById("status").innerText = "GPS 定位失敗 (請檢查權限或 HTTPS)"; 
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }
}

function updateUISelection(id, value) {
    document.querySelectorAll(`${id} button`).forEach(b => {
        b.classList.toggle("active", (b.dataset.region || b.dataset.type || b.dataset.mode) === value);
    });
}

function clearMarkers() { markers.forEach(m => m.setMap(null)); markers = []; }

window.onload = initMap;