document.addEventListener('DOMContentLoaded', async () => {
    /*
     * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
     * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
     * Copyright (C) 2025 MundoGIS.
     */

    
    // 1. Inicializar Mapa
    const map = L.map('mapid').setView([62, 15], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    const drawControl = new L.Control.Draw({
        draw: { polygon: true, marker: false, circle: false, rectangle: true, polyline: false, circlemarker: false },
        edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);

    const lanSelect = document.getElementById('lan-select');
    const hojdCollectionSelect = document.getElementById('hojd-collection-select');
    const hojdCollectionLicenseDiv = document.getElementById('hojd-collection-license');
    const hojdAcceptLicenseCheckbox = document.getElementById('hojd-accept-license');
    const clearGeometryBtn = document.getElementById('clear-geometry-btn');
    const geometryIndicator = document.getElementById('geometry-indicator');

    const defaultLanStyle = { color: '#5c6f82', weight: 1, fillOpacity: 0, interactive: false };
    const selectedLanStyle = { color: '#ff6b00', weight: 2, fillOpacity: 0.1, interactive: false };
    const lanLayer = L.geoJSON(null, {
        style: () => defaultLanStyle,
        pane: 'overlayPane',
        onEachFeature: (feature, layer) => {
            const lanName = feature.properties.Lan || feature.properties.lan || `Län ${feature.properties.id}`;
            const center = layer.getBounds().getCenter();
            L.marker(center, {
                icon: L.divIcon({
                    className: 'lan-label',
                    html: `<div style="font-size:11px;font-weight:600;color:#333;text-shadow:1px 1px 2px white,-1px -1px 2px white,1px -1px 2px white,-1px 1px 2px white;white-space:nowrap;pointer-events:none;">${lanName}</div>`,
                    iconSize: [0, 0]
                }),
                interactive: false
            }).addTo(map);
        }
    }).addTo(map);

    let lanFeatures = [];
    let selectedLanId = null;
    let currentGeometry = null;
    let currentGeometryLabel = 'Ingen geometri vald.';
    let currentGeometryName = null;

    function updateGeometryIndicator() {
        geometryIndicator.textContent = currentGeometryLabel;
    }

    function applyLanStyle() {
        lanLayer.eachLayer(layer => {
            const isSelected = selectedLanId !== null && String(layer.feature.properties.id) === String(selectedLanId);
            layer.setStyle(isSelected ? selectedLanStyle : defaultLanStyle);
        });
    }

    function setCurrentGeometry(geometry, label, name = null) {
        currentGeometry = geometry;
        currentGeometryLabel = label || 'Geometri vald.';
        currentGeometryName = name;
        updateGeometryIndicator();
    }

    function clearGeometry() {
        drawnItems.clearLayers();
        lanSelect.value = '';
        selectedLanId = null;
        currentGeometry = null;
        currentGeometryLabel = 'Ingen geometri vald.';
        currentGeometryName = null;
        applyLanStyle();
        updateGeometryIndicator();
    }

    function parseGeoJsonCrsName(rawCrs) {
        if (!rawCrs) return 'EPSG:4326';
        if (typeof rawCrs === 'string') {
            const normalized = rawCrs.trim().replace(/^urn:ogc:def:crs:epsg::/i, 'EPSG:').replace(/^epsg:/i, 'EPSG:').toUpperCase();
            if (/^EPSG:\d+$/i.test(normalized)) return normalized;
            const match = normalized.match(/EPSG[:\s]*(\d+)/i);
            if (match) return `EPSG:${match[1]}`;
            return 'EPSG:4326';
        }
        if (rawCrs.type === 'name' && rawCrs.properties && rawCrs.properties.name) {
            return parseGeoJsonCrsName(rawCrs.properties.name);
        }
        if (rawCrs.properties && rawCrs.properties.code) {
            return parseGeoJsonCrsName(rawCrs.properties.code);
        }
        return 'EPSG:4326';
    }

    function webMercatorToLonLat(x, y) {
        const lon = (x / 20037508.34) * 180;
        const lat = (2 * Math.atan(Math.exp((y / 20037508.34) * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
        return [lon, lat];
    }

    function sweref99tmToWgs84(x, y) {
        const a = 6378137;
        const f = 1 / 298.257222101;
        const e2 = 1 - (1 - f) * (1 - f);
        const ePrime2 = e2 / (1 - e2);
        const k0 = 0.9996;
        const x0 = 500000;
        const x1 = x - x0;
        const M = y / k0;
        const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
        const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
        const phi1 = mu + ((3 * e1 / 2) - (27 * e1 * e1 * e1 / 32)) * Math.sin(2 * mu) + ((21 * e1 * e1 / 16) - (55 * e1 * e1 * e1 * e1 / 32)) * Math.sin(4 * mu) + ((151 * e1 * e1 * e1 / 96)) * Math.sin(6 * mu);
        const C1 = ePrime2 * Math.cos(phi1) * Math.cos(phi1);
        const T1 = Math.tan(phi1) * Math.tan(phi1);
        const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) * Math.sin(phi1));
        const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi1) * Math.sin(phi1), 1.5);
        const D = x1 / (N1 * k0);
        const lat = phi1 - (N1 * Math.tan(phi1) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ePrime2) * Math.pow(D, 4)) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ePrime2 - 3 * C1 * C1) * Math.pow(D, 6)) / 720);
        const lon = (15 * Math.PI / 180) + (D - ((1 + 2 * T1 + C1) * Math.pow(D, 3)) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ePrime2 + 24 * T1 * T1) * Math.pow(D, 5)) / 120) / Math.cos(phi1);
        return [lon * (180 / Math.PI), lat * (180 / Math.PI)];
    }

    function projectPointToWgs84([x, y], sourceCrs = 'EPSG:4326') {
        const crs = parseGeoJsonCrsName(sourceCrs);
        if (crs === 'EPSG:4326') return [x, y];
        if (crs === 'EPSG:3857') return webMercatorToLonLat(x, y);
        if (crs === 'EPSG:3006') return sweref99tmToWgs84(x, y);
        return [x, y];
    }

    function transformCoordinateTree(value, sourceCrs = 'EPSG:4326') {
        if (!Array.isArray(value)) return value;
        if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
            return projectPointToWgs84([value[0], value[1]], sourceCrs);
        }
        return value.map(item => transformCoordinateTree(item, sourceCrs));
    }

    function normalizeGeoJsonGeometry(geometry, inheritedCrs = 'EPSG:4326') {
        if (!geometry || typeof geometry !== 'object') return null;

        const sourceCrs = parseGeoJsonCrsName(geometry.crs || geometry.properties?.crs || inheritedCrs);

        if (geometry.type === 'FeatureCollection') {
            const features = (geometry.features || []).map(feature => normalizeGeoJsonGeometry(feature, sourceCrs)).filter(Boolean);
            const polygons = features.flatMap(item => item.type === 'Polygon' ? [item.coordinates] : item.coordinates);
            if (!polygons.length) return null;
            return polygons.length === 1
                ? { type: 'Polygon', coordinates: polygons[0] }
                : { type: 'MultiPolygon', coordinates: polygons };
        }

        if (geometry.type === 'Feature') {
            return normalizeGeoJsonGeometry(geometry.geometry, sourceCrs);
        }

        if ((geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && geometry.coordinates) {
            return {
                type: geometry.type,
                coordinates: transformCoordinateTree(geometry.coordinates, sourceCrs)
            };
        }

        return null;
    }

    function applyGeometryToMap(geometry, label) {
        const layer = L.geoJSON(geometry, {
            style: { color: '#ff6b00', weight: 2, fillOpacity: 0.2 }
        });
        const bounds = layer.getBounds();
        if (!bounds.isValid()) throw new Error('Ogiltig geometri');
        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        map.fitBounds(bounds.pad(0.2));
        lanSelect.value = '';
        selectedLanId = null;
        currentGeometryName = null;
        applyLanStyle();
        currentGeometry = geometry;
        currentGeometryLabel = label || 'Geometri vald.';
        updateGeometryIndicator();
        return geometry;
    }

    const geoJsonUploadInput = document.getElementById('geojson-upload');
    if (geoJsonUploadInput) {
        geoJsonUploadInput.addEventListener('change', async (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const geometry = normalizeGeoJsonGeometry(parsed);
                if (!geometry) {
                    throw new Error('GeoJSON inválido');
                }
                applyGeometryToMap(geometry, `Área cargada desde ${file.name}`);
                showMsg(`Área cargada desde ${file.name}.`, 'success');
            } catch (error) {
                console.error('Error al leer GeoJSON:', error);
                showMsg('El GeoJSON no es válido. Debe incluir un Polygon, MultiPolygon o FeatureCollection válido.', 'error');
            } finally {
                event.target.value = '';
            }
        });
    }

    map.on(L.Draw.Event.CREATED, (e) => {
        drawnItems.clearLayers();
        drawnItems.addLayer(e.layer);
        const geojson = e.layer.toGeoJSON();
        lanSelect.value = '';
        selectedLanId = null;
        applyLanStyle();
        setCurrentGeometry(geojson.geometry, 'Ritad polygon');
        console.log('Geometría capturada (GeoJSON):', geojson.geometry);
    });

    map.on(L.Draw.Event.DELETED, () => {
        if (!lanSelect.value) {
            currentGeometry = null;
            currentGeometryLabel = 'Ingen geometri vald.';
            currentGeometryName = null;
            updateGeometryIndicator();
        }
    });

    clearGeometryBtn.addEventListener('click', () => {
        clearGeometry();
    });

    async function loadLanData() {
        try {
            const res = await fetch('/lmv/lan');
            const payload = await res.json();
            if (!payload.success || !payload.data) {
                throw new Error('Ogiltigt svar från servern');
            }

            lanFeatures = payload.data.features || [];
            lanLayer.addData(payload.data);
            lanFeatures.forEach(feature => {
                const opt = document.createElement('option');
                const lanName = feature.properties.Lan || feature.properties.lan || `Län ${feature.properties.id}`;
                opt.value = feature.properties.id;
                opt.textContent = lanName;
                lanSelect.appendChild(opt);
            });
            applyLanStyle();
        } catch (err) {
            console.error('Kunde inte ladda län:', err.message);
        }
    }

    await loadLanData();

    // Cargar colecciones de höjd usando la API (requiere API Key en header)
    async function loadHojdCollections() {
        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiKey = document.getElementById('apiKey').value;
        const apiToken = document.getElementById('apiToken').value;
        if (!hojdCollectionSelect) return; // nothing to do if select is removed from DOM
        try {
            const headers = {};
            if (authMethod === 'token' && apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
            if (authMethod === 'userpass' && apiKey) headers['X-API-Key'] = apiKey;
            const res = await fetch('/lmv/hojd/collections', { headers });
            const json = await res.json();
            if (!json.success || !Array.isArray(json.collections)) return;

            hojdCollectionSelect.innerHTML = '';
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.selected = true;
            noneOpt.textContent = '– Ingen samling vald –';
            hojdCollectionSelect.appendChild(noneOpt);

            json.collections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col.id || col.title || '';
                opt.textContent = col.title || col.id || opt.value;
                if (col.license) opt.dataset.license = col.license;
                hojdCollectionSelect.appendChild(opt);
            });
        } catch (e) {
            console.warn('Kunde inte ladda höjd-kollektioner:', e.message);
        }
    }

    // Cargar cuando cambie la API key
    document.getElementById('apiKey').addEventListener('change', loadHojdCollections);
    document.getElementById('apiKey').addEventListener('blur', loadHojdCollections);
    const authRadios = document.getElementsByName('auth-method');
    Array.from(authRadios).forEach(r => r.addEventListener('change', loadHojdCollections));

    if (hojdCollectionSelect) {
        hojdCollectionSelect.addEventListener('change', () => {
            const sel = hojdCollectionSelect.selectedOptions[0];
            const lic = sel ? sel.dataset.license : null;
            if (lic) {
                hojdCollectionLicenseDiv.style.display = 'block';
                hojdCollectionLicenseDiv.innerHTML = 'Licens: ' + lic + ' — <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC-BY-4.0</a>';
            } else {
                hojdCollectionLicenseDiv.style.display = 'none';
                hojdCollectionLicenseDiv.textContent = '';
            }
            hojdAcceptLicenseCheckbox.checked = false;
        });
    }

    lanSelect.addEventListener('change', () => {
        const selectedId = lanSelect.value;
        if (!selectedId) {
            selectedLanId = null;
            if (!drawnItems.getLayers().length) {
                currentGeometry = null;
                currentGeometryLabel = 'Ingen geometri vald.';
                updateGeometryIndicator();
            }
            applyLanStyle();
            return;
        }

        const feature = lanFeatures.find(f => String(f.properties.id) === String(selectedId));
        if (!feature) return;

        selectedLanId = selectedId;
        applyLanStyle();
        drawnItems.clearLayers();
        const layer = L.geoJSON(feature);
        map.fitBounds(layer.getBounds().pad(0.05));
        const lanName = feature.properties.Lan || feature.properties.lan || selectedId;
        setCurrentGeometry(feature.geometry, `Län: ${lanName}`, lanName);
    });

    // 2. Cargar Colecciones de Höjd (ya no se usa el dropdown)
    const messageDiv = document.getElementById('result-message');
    const btn = document.getElementById('start-download-btn');
    const downloadAllBtn = document.getElementById('download-all-btn');
    const stopBtn = document.getElementById('stop-download-btn');
    
    let currentDownloadId = null;

    function showMsg(text, type) {
        const g = document.getElementById('global-notification');
        if (g) {
            let cls = 'is-info';
            if (type === 'error') cls = 'is-danger';
            else if (type === 'success') cls = 'is-success';
            g.className = `notification ${cls}`;
            g.textContent = text;
            g.style.display = 'block';
            clearTimeout(g._hideTimeout);
            g._hideTimeout = setTimeout(() => { g.style.display = 'none'; }, 6000);
        } else {
            messageDiv.style.display = 'block';
            messageDiv.textContent = text;
            messageDiv.style.backgroundColor = type === 'error' ? '#f8d7da' : '#d4edda';
            messageDiv.style.color = type === 'error' ? '#721c24' : '#155724';
        }
    }

    // Función para cargar colecciones con API key
    // Función loadCollections comentada (ya no se usa)
    /*
    async function loadCollections() {
        const apiKey = document.getElementById('apiKey').value;
        if (!apiKey) {
            showMsg('Ange API Key först för att ladda kollektioner.', 'error');
            return;
        }

        try {
            const res = await fetch('/lmv/hojd/collections', {
                headers: { 'X-API-Key': apiKey }
            });
            const data = await res.json();
            
            if (!data.success) {
                showMsg('Fel vid laddning av kollektioner: ' + (data.error || 'Okänt fel'), 'error');
                return;
            }
            
            // Código de procesamiento de colecciones...
        } catch (e) {
            showMsg('Kunde inte ladda kollektioner.', 'error');
        }
    }
    */

    // Función loadCollections ya no se usa (dropdown eliminado)
    // async function loadCollections() { ... }

    // Event listeners comentados (ya no cargan colecciones)
    // document.getElementById('apiKey').addEventListener('change', loadCollections);
    // document.getElementById('apiKey').addEventListener('blur', loadCollections);

    // 3. Manejar Click en Descargar
    async function triggerDownload(payload, button, label) {
        button.disabled = true;
        button.textContent = 'Startar...';
        try {
                // Preflight validation from client
                try {
                    const vres = await fetch('/lmv/validate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ apiUsername: payload.apiUsername, apiKey: payload.apiKey, apiToken: payload.apiToken, collectionId: payload.collectionId, apiType: payload.apiType })
                    });
                    if (vres.status === 401 || vres.status === 403) {
                        showMsg('Fel: Ogiltigt användarnamn eller API-nyckel. Kontrollera dina uppgifter.', 'error');
                        return;
                    }
                } catch (e) {
                    console.warn('Validering misslyckades (client):', e.message);
                }

                const res = await fetch('/lmv/start-full-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res.status === 401 || res.status === 403) {
                    showMsg('Fel: Ogiltigt användarnamn eller API-nyckel. Kontrollera dina uppgifter.', 'error');
                    return;
                }

                const json = await res.json();
                if (json.success) {
                    showMsg(`${json.message} Följ förloppet live under 📦 Nedladdningar.`, 'success');
                    if (json.downloadId) {
                        currentDownloadId = json.downloadId;
                        stopBtn.style.display = 'inline-block';
                    }
                } else {
                    showMsg('Fel: ' + json.error, 'error');
                }
        } catch (e) {
            showMsg('Nätverksfel.', 'error');
        } finally {
            setTimeout(() => { button.disabled = false; button.textContent = label; }, 3000);
        }
    }

    stopBtn.addEventListener('click', async () => {
        if (!currentDownloadId) return;
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stoppar...';
        try {
            const res = await fetch('/lmv/cancel-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadId: currentDownloadId })
            });
            const json = await res.json();
            if (json.success) {
                showMsg('Nedladdning stoppad.', 'success');
            } else {
                showMsg('Kunde inte stoppa: ' + json.error, 'error');
            }
        } catch (e) {
            showMsg('Nätverksfel.', 'error');
        } finally {
            currentDownloadId = null;
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
            stopBtn.textContent = '⏹ Stoppa Nedladdning';
        }
    });

    btn.addEventListener('click', () => {
        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiUsername = document.getElementById('apiUsername').value;
        const apiKey = document.getElementById('apiKey').value;
        const apiToken = document.getElementById('apiToken').value;
        if (authMethod === 'userpass' && (!apiUsername || !apiKey)) return showMsg('Ange användarnamn och API Key.', 'error');
        if (authMethod === 'token' && !apiToken) return showMsg('Ange Auth token.', 'error');
        if (!currentGeometry) return showMsg('Välj ett län eller rita ett område på kartan.', 'error');
        
        const geometryPayload = currentGeometry || null;
        // Verificar aceptación de licencia si en samling vald
        const selOpt = hojdCollectionSelect ? hojdCollectionSelect.selectedOptions[0] : null;
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !hojdAcceptLicenseCheckbox.checked) {
            return showMsg('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
        }

        triggerDownload({
            apiUsername,
            apiKey,
            apiToken: apiToken || undefined,
            collectionId: hojdCollectionSelect && hojdCollectionSelect.value ? hojdCollectionSelect.value : 'ALL_MARKHOJD', // usar samling si vald
            apiType: 'hojd',
            geometry: geometryPayload,
            geometryLabel: currentGeometryName
        }, btn, 'Starta Nedladdning');
    });

    downloadAllBtn.addEventListener('click', () => {
        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiUsername = document.getElementById('apiUsername').value;
        const apiKey = document.getElementById('apiKey').value;
        const apiToken = document.getElementById('apiToken').value;
        if (authMethod === 'userpass' && (!apiUsername || !apiKey)) return showMsg('Ange användarnamn och API Key.', 'error');
        if (authMethod === 'token' && !apiToken) return showMsg('Ange Auth token.', 'error');
        // Para descarga completa, si hay samling seleccionada exigir aceptación
        const selOpt = hojdCollectionSelect ? hojdCollectionSelect.selectedOptions[0] : null;
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !hojdAcceptLicenseCheckbox.checked) {
            return showMsg('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
        }
        triggerDownload({
            apiUsername,
            apiKey,
            apiToken: apiToken || undefined,
            collectionId: hojdCollectionSelect && hojdCollectionSelect.value ? hojdCollectionSelect.value : 'ALL_MARKHOJD',
            apiType: 'hojd',
            geometry: null,
            geometryLabel: null
        }, downloadAllBtn, 'Ladda ner hela Sverige');
    });
});