/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */


// --- Variables Globales de Estado (LMV) ---
// Elementos del DOM se declararán después de DOMContentLoaded
let lmvForm, prepareBtn, resultMessage, downloadSection, downloadBtn;
let foundCollectionName, foundItemCount, downloadInfo, downloadLinksList;
let minLonInput, maxLonInput, minLatInput, maxLatInput;

// Variables de estado
let currentCollectionId = null;
let currentWKTGeometry = null;
let currentApiKey = null;
let currentItemsCount = 0;

// --- Inicialización del Mapa Leaflet ---
let map = null;
let drawnItems = null;

function initializeMap() {
    if (map) return; // Evitar reinicializar

    map = L.map('mapid').setView([62, 15], 4); // Centrado aprox en Suecia
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18,
    }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
            polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
            rectangle: { shapeOptions: { color: '#007bff' } }
        }
    });
    map.addControl(drawControl);

    // --- Eventos del mapa ---
    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;
        const bounds = layer.getBounds();
        const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
        const minLon = southWest.lng; const minLat = southWest.lat;
        const maxLon = northEast.lng; const maxLat = northEast.lat;

        // Guardar como GeoJSON en lugar de WKT
        currentWKTGeometry = {
            type: 'Polygon',
            coordinates: [[
                [minLon, minLat],
                [maxLon, minLat],
                [maxLon, maxLat],
                [minLon, maxLat],
                [minLon, minLat]
            ]]
        };
        console.log("Geometría desde mapa (GeoJSON):", JSON.stringify(currentWKTGeometry));

        minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
        minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);

        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        showMessage("Område definierat på kartan. Koordinatfälten har uppdaterats.", "success");
    });

    map.on(L.Draw.Event.DELETED, function() {
        currentWKTGeometry = null;
        minLonInput.value = ''; maxLonInput.value = '';
        minLatInput.value = ''; maxLatInput.value = '';
        console.log("WKT Geometry och koordinatfält rensade");
        showMessage("Området har tagits bort från kartan.", "info");
    });

    map.on(L.Draw.Event.EDITED, function (event) {
        event.layers.eachLayer(function (layer) {
            const bounds = layer.getBounds();
            const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
            const minLon = southWest.lng; const minLat = southWest.lat;
            const maxLon = northEast.lng; const maxLat = northEast.lat;
            
            currentWKTGeometry = {
                type: 'Polygon',
                coordinates: [[
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat]
                ]]
            };
            console.log("Geometría editada (GeoJSON):", JSON.stringify(currentWKTGeometry));
            minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
            minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);
        });
        showMessage("Området har redigerats på kartan. Koordinatfälten har uppdaterats.", "success");
    });
}

// --- Función para validar coordenadas de los inputs y generar GeoJSON ---
function validateAndGetWKTFromInputs() {
    if (!minLonInput || !maxLonInput || !minLatInput || !maxLatInput) return null;
    
    const minLonStr = minLonInput.value; const maxLonStr = maxLonInput.value;
    const minLatStr = minLatInput.value; const maxLatStr = maxLatInput.value;

    if (!minLonStr || !maxLonStr || !minLatStr || !maxLatStr) { return null; }

    const minLon = parseFloat(minLonStr); const maxLon = parseFloat(maxLonStr);
    const minLat = parseFloat(minLatStr); const maxLat = parseFloat(maxLatStr);

    if (isNaN(minLon) || isNaN(maxLon) || isNaN(minLat) || isNaN(maxLat) ||
        minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 ||
        minLon >= maxLon || minLat >= maxLat) {
        return null;
    }
    
    // Retornar GeoJSON directamente en lugar de WKT
    const geoJson = {
        type: 'Polygon',
        coordinates: [[
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat]
        ]]
    };
    console.log("GeoJSON generado desde coordenadas:", JSON.stringify(geoJson));
    return geoJson;
}

// --- Funciones de Mensajes ---
function showMessage(message, type) {
    const g = document.getElementById('global-notification');
    if (g) {
        // Map type to Bulma class
        let cls = 'is-info';
        if (type === 'error') cls = 'is-danger';
        else if (type === 'success') cls = 'is-success';
        g.className = `notification ${cls}`;
        g.textContent = message;
        g.style.display = 'block';
        // Auto-hide after 6 seconds
        clearTimeout(g._hideTimeout);
        g._hideTimeout = setTimeout(() => { g.style.display = 'none'; }, 6000);
    } else if (resultMessage) {
        resultMessage.textContent = message;
        resultMessage.className = '';
        resultMessage.classList.add('message', type);
    }
    if (downloadSection) downloadSection.style.display = 'none';
    if (downloadInfo) downloadInfo.style.display = 'none';
    if (downloadLinksList) downloadLinksList.innerHTML = '';
}

function clearMessages() {
    const g = document.getElementById('global-notification');
    if (g) { g.style.display = 'none'; clearTimeout(g._hideTimeout); }
    if (!resultMessage) return;
    resultMessage.textContent = '';
    resultMessage.className = '';
    if (downloadSection) downloadSection.style.display = 'none';
    if (downloadInfo) downloadInfo.style.display = 'none';
    if (downloadLinksList) downloadLinksList.innerHTML = '';
}

function disableButtons(disable) {
    if (prepareBtn) prepareBtn.disabled = disable;
    if (downloadBtn) downloadBtn.disabled = disable;
}

// ===== INICIALIZACIÓN CUANDO EL DOM ESTÁ LISTO =====
document.addEventListener('DOMContentLoaded', function() {
    // Inicializar elementos del DOM
    lmvForm = document.getElementById('lmv-form');
    prepareBtn = document.getElementById('prepare-btn');
    resultMessage = document.getElementById('result-message');
    downloadSection = document.getElementById('download-section');
    downloadBtn = document.getElementById('download-btn');
    foundCollectionName = document.getElementById('found-collection-name');
    foundItemCount = document.getElementById('found-item-count');
    downloadInfo = document.getElementById('download-info');
    downloadLinksList = document.getElementById('download-links-list');
    
    minLonInput = document.getElementById('min-lon');
    maxLonInput = document.getElementById('max-lon');
    minLatInput = document.getElementById('min-lat');
    maxLatInput = document.getElementById('max-lat');
    
    const fullDownloadBtn = document.getElementById('start-full-download-btn');
    const collectionSelect = document.getElementById('collection-select');
    const collectionLicenseDiv = document.getElementById('collection-license');
    const acceptLicenseCheckbox = document.getElementById('accept-license');
    
    let currentDownloadId = null;
    const stopBtn = document.getElementById('stop-download-btn');

    // Inicializar el mapa
    initializeMap();
    
    // Cargar credenciales guardadas
    const rememberCheckbox = document.getElementById('remember-credentials');
    const savedUsername = localStorage.getItem('lmv_username');
    const savedApiKey = localStorage.getItem('lmv_apikey');
    const savedRemember = localStorage.getItem('lmv_remember');
    
    if (savedRemember === 'true' && savedUsername && savedApiKey) {
        document.getElementById('apiUsername').value = savedUsername;
        document.getElementById('apiKey').value = atob(savedApiKey);
        rememberCheckbox.checked = true;
    }
    
    // Guardar credenciales al cambiar checkbox
    rememberCheckbox.addEventListener('change', function() {
        if (this.checked) {
            const username = document.getElementById('apiUsername').value;
            const apiKey = document.getElementById('apiKey').value;
            if (username && apiKey) {
                localStorage.setItem('lmv_username', username);
                localStorage.setItem('lmv_apikey', btoa(apiKey));
                localStorage.setItem('lmv_remember', 'true');
            }
        } else {
            localStorage.removeItem('lmv_username');
            localStorage.removeItem('lmv_apikey');
            localStorage.removeItem('lmv_remember');
        }
    });
    
    // ===== EVENT LISTENERS =====

    // Cargar colecciones dinámicamente desde el backend
    async function loadCollections() {
        try {
            const res = await fetch('/lmv/collections');
            const json = await res.json();
            if (!json.success || !Array.isArray(json.collections)) return;

            // Limpiar y poblar
            collectionSelect.innerHTML = '';
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.disabled = true;
            emptyOpt.selected = true;
            emptyOpt.textContent = '-- Välj en kollektion --';
            collectionSelect.appendChild(emptyOpt);

            json.collections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col.id || col.collection || col.title || '';
                opt.textContent = col.title || col.id || opt.value;
                // Guardar licencia en data attr
                if (col.license) opt.dataset.license = col.license;
                collectionSelect.appendChild(opt);
            });
        } catch (e) {
            console.warn('Kunde inte ladda kollektioner:', e.message);
        }
    }

    // Llamar al cargar la página
    loadCollections();

    collectionSelect.addEventListener('change', () => {
        const sel = collectionSelect.selectedOptions[0];
        const lic = sel ? sel.dataset.license : null;
        if (lic) {
            collectionLicenseDiv.style.display = 'block';
            collectionLicenseDiv.innerHTML = 'Licens: ' + lic + ' — <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC-BY-4.0</a>';
        } else {
            collectionLicenseDiv.style.display = 'none';
            collectionLicenseDiv.textContent = '';
        }
        // Reset accept checkbox cuando cambia la colección
        acceptLicenseCheckbox.checked = false;
    });
    
    // Event Listener principal del formulario
    lmvForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessages();
        disableButtons(true);

        const apiUsername = document.getElementById('apiUsername').value.trim();
        const apiKey = document.getElementById('apiKey').value.trim();
        const collectionId = document.getElementById('collection-select').value;

        if (!apiUsername) { showMessage('Vänligen ange ditt användarnamn.', 'error'); disableButtons(false); return; }
        if (!apiKey) { showMessage('Vänligen ange din LMV STAC API Key.', 'error'); disableButtons(false); return; }
        if (!collectionId) { showMessage('Vänligen välj en datakollektion.', 'error'); disableButtons(false); return; }
        // Verificar aceptación de licencia
        const selOpt = collectionSelect.selectedOptions[0];
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !acceptLicenseCheckbox.checked) {
            showMessage('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
            disableButtons(false);
            return;
        }

        let geometry = validateAndGetWKTFromInputs();
        if (!geometry) {
            showMessage('Vänligen rita en rektangel på kartan eller fyll i giltiga koordinater.', 'error');
            disableButtons(false);
            return;
        }

        const payload = {
            apiUsername,
            apiKey,
            collectionId,
            apiType: 'vektor',
            geometry: geometry
        };

        await triggerDownload(payload, document.getElementById('prepare-btn'), 'Starta nedladdning');

        setTimeout(() => { disableButtons(false); }, 1000);
    });

    async function triggerDownload(payload, button, label) {
        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = 'Startar...';
        try {
            // Preflight validation
            try {
                const vres = await fetch('/lmv/validate', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiUsername: payload.apiUsername, apiKey: payload.apiKey, collectionId: payload.collectionId, apiType: payload.apiType })
                });
                if (vres.status === 401 || vres.status === 403) {
                    showMessage('Fel: Ogiltigt användarnamn eller API-nyckel. Kontrollera dina uppgifter.', 'error');
                    return;
                }
            } catch (e) {
                console.warn('Validering misslyckades:', e.message);
            }

            const res = await fetch('/lmv/start-full-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.status === 401 || res.status === 403) {
                showMessage('Fel: Ogiltigt användarnamn eller API-nyckel. Kontrollera dina uppgifter.', 'error');
                return;
            }

            const json = await res.json();
            if (json.success) {
                showMessage(json.message || 'Nedladdning startad i bakgrunden.', 'success');
                if (json.downloadId) {
                    currentDownloadId = json.downloadId;
                    if (stopBtn) stopBtn.style.display = 'inline-block';
                }
            } else {
                showMessage('Fel: ' + (json.error || 'okänt fel'), 'error');
            }
        } catch (e) {
            console.error('Fel vid start av nedladdning:', e);
            showMessage('Nätverksfel.', 'error');
        } finally {
            setTimeout(() => { button.disabled = false; button.textContent = originalText; }, 2000);
        }
    }

    // Manejar Stop-knapp
    if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
            if (!currentDownloadId) return;
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stoppar...';
            try {
                const res = await fetch('/lmv/cancel-download', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ downloadId: currentDownloadId })
                });
                const json = await res.json();
                if (json.success) showMessage('Nedladdning stoppad.', 'success');
                else showMessage('Kunde inte stoppa: ' + (json.error || 'okänt fel'), 'error');
            } catch (e) {
                showMessage('Nätverksfel vid stopp.', 'error');
            } finally {
                currentDownloadId = null;
                stopBtn.style.display = 'none';
                stopBtn.disabled = false;
                stopBtn.textContent = '⏹ Stoppa Nedladdning';
            }
        });
    }

    // Event Listener para el botón de descarga (ya no se usa)
    if (downloadBtn) {
        downloadBtn.addEventListener('click', async () => {
            showMessage('Använd formuläret ovan för att starta nedladdning.', 'info');
        });
    }

    // Event Listener para el botón de descarga completa -> usar triggerDownload para permitir stop
    fullDownloadBtn.addEventListener('click', async () => {
        console.log("Knappen 'Ladda ner hela Sverige' klickades.");

        const apiUsername = document.getElementById('apiUsername').value.trim();
        const apiKey = document.getElementById('apiKey').value.trim();
        const collectionId = document.getElementById('collection-select').value;

        if (!apiUsername || !apiKey || !collectionId) {
            showMessage('Ange ditt användarnamn, API-nyckel och välj en samling innan du startar nedladdningen.', 'error');
            return;
        }
        // Verificar aceptación de licencia para descarga completa
        const selOpt = collectionSelect.selectedOptions[0];
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !acceptLicenseCheckbox.checked) {
            showMessage('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
            return;
        }

        let geometry = currentWKTGeometry || null;
        if (!geometry) {
            const minLon = parseFloat(minLonInput.value);
            const maxLon = parseFloat(maxLonInput.value);
            const minLat = parseFloat(minLatInput.value);
            const maxLat = parseFloat(maxLatInput.value);
            if (!isNaN(minLon) && !isNaN(maxLon) && !isNaN(minLat) && !isNaN(maxLat)) {
                geometry = {
                    type: 'Polygon',
                    coordinates: [[
                        [minLon, minLat],
                        [maxLon, minLat],
                        [maxLon, maxLat],
                        [minLon, maxLat],
                        [minLon, minLat]
                    ]]
                };
            }
        }

        const payload = {
            apiUsername: apiUsername,
            apiKey: apiKey,
            collectionId: collectionId,
            apiType: 'vektor',
            geometry: geometry || null
        };

        await triggerDownload(payload, fullDownloadBtn, '🚀 Starta nedladdning för hela Sverige');
        setTimeout(() => { disableButtons(false); }, 3000);
    });
});
