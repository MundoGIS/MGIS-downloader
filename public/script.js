
/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */


// --- DOM-element ---
const speciesForm = document.getElementById('species-form');
const checkBtn = document.getElementById('check-btn');
const resultMessage = document.getElementById('result-message');
const downloadSection = document.getElementById('download-section');
const downloadBtn = document.getElementById('download-btn');
const foundSpeciesName = document.getElementById('found-species-name');
const downloadInfo = document.getElementById('download-info');
const downloadKeySpan = document.getElementById('download-key');
const acceptGbifCheckbox = document.getElementById('accept-gbif-license');
// Koordinat-inputs
const minLonInput = document.getElementById('min-lon');
const maxLonInput = document.getElementById('max-lon');
const minLatInput = document.getElementById('min-lat');
const maxLatInput = document.getElementById('max-lat');

// --- Variables Globales de Estado ---
let currentSpeciesKey = null; // "ALL" o clave numérica
let currentBasisOfRecord = null;
let currentWKTGeometry = null; // Guardará el WKT válido (del mapa o de los inputs)
let currentUsername = null;
let currentPassword = null;
let map = null; // Variable para la instancia del mapa Leaflet
let drawnItems = null; // Capa para guardar los dibujos

// --- Inicialización del Mapa Leaflet ---
function initializeMap() {
    if (map) return; // Evitar reinicializar

    map = L.map('mapid').setView([62, 15], 4); // Centrado aprox en Suecia
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18,
    }).addTo(map);

    // Capa para guardar el dibujo del usuario
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Controles de dibujo (solo rectángulo)
    const drawControl = new L.Control.Draw({
        edit: {
            featureGroup: drawnItems, // Permite editar/borrar el dibujo
            remove: true
        },
        draw: {
            polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
            rectangle: { shapeOptions: { color: '#007bff' } } // Habilitar rectángulo
        /*
         * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
         * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
         * Copyright (C) 2025 MundoGIS.
         */
        }
    });
    map.addControl(drawControl);

    // --- Evento: Cuando se CREA un rectángulo ---
    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;
        const bounds = layer.getBounds();
        const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
        const minLon = southWest.lng; const minLat = southWest.lat;
        const maxLon = northEast.lng; const maxLat = northEast.lat;

        // Construir WKT y guardarlo
        const wkt = `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
        currentWKTGeometry = wkt;
        console.log("WKT Geometry (from map):", currentWKTGeometry);

        // Actualizar los inputs manuales
        minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
        minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);

        // Mostrar dibujo en mapa
        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        showMessage("Område definierat på kartan. Koordinatfälten har uppdaterats.", "success");
    });

    // --- Evento: Cuando se BORRA un dibujo ---
    map.on(L.Draw.Event.DELETED, function() {
        currentWKTGeometry = null; // Limpiar WKT guardado
        minLonInput.value = ''; maxLonInput.value = ''; // Limpiar inputs
        minLatInput.value = ''; maxLatInput.value = '';
        console.log("WKT Geometry och koordinatfält rensade");
        showMessage("Området har tagits bort från kartan.", "info");
    });

    // --- Evento: Cuando se EDITA un dibujo ---
     map.on(L.Draw.Event.EDITED, function (event) {
        event.layers.eachLayer(function (layer) { // Asume que solo hay una capa editable
             const bounds = layer.getBounds();
             const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
             const minLon = southWest.lng; const minLat = southWest.lat;
             const maxLon = northEast.lng; const maxLat = northEast.lat;
             // Actualizar WKT y inputs
             currentWKTGeometry = `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
             console.log("WKT Geometry (edited map):", currentWKTGeometry);
             minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
             minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);
        });
        showMessage("Området har redigerats på kartan. Koordinatfälten har uppdaterats.", "success");
    });
}
// Inicializar el mapa cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', initializeMap);


// --- Función para validar coordenadas de los inputs y generar WKT ---
function validateAndGetWKTFromInputs() {
    const minLonStr = minLonInput.value; const maxLonStr = maxLonInput.value;
    const minLatStr = minLatInput.value; const maxLatStr = maxLatInput.value;

    if (!minLonStr || !maxLonStr || !minLatStr || !maxLatStr) { return null; } // Incompleto

    const minLon = parseFloat(minLonStr); const maxLon = parseFloat(maxLonStr);
    const minLat = parseFloat(minLatStr); const maxLat = parseFloat(maxLatStr);

    if (isNaN(minLon) || isNaN(maxLon) || isNaN(minLat) || isNaN(maxLat) ||
        minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 ||
        minLon >= maxLon || minLat >= maxLat) {
        // Solo muestra mensaje si se intenta enviar el formulario, no aquí directamente
        // showMessage('Ogiltiga koordinater i fälten...', 'error');
        return null; // Inválido
    }
    // Válido, devolver WKT
    return `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
}

// --- Event Listener principal del formulario ---
speciesForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();
    disableButtons(true); // Deshabilitar al inicio

    // Verificar aceptación de licensvillkor för GBIF
    if (acceptGbifCheckbox && !acceptGbifCheckbox.checked) {
        showMessage('Du måste godkänna licensvillkoren för GBIF-data innan du fortsätter.', 'error');
        disableButtons(false);
        return;
    }

    // 1. Obtener datos comunes y validar básicos
    currentUsername = document.getElementById('username').value.trim();
    currentPassword = document.getElementById('password').value;
    currentBasisOfRecord = document.getElementById('basis-of-record-select').value;
    const speciesNameOrAll = document.getElementById('species-select').value;

    if (!currentUsername || !currentPassword) { showMessage('Vänligen ange GBIF användarnamn och lösenord.', 'error'); disableButtons(false); return; }
    if (!speciesNameOrAll) { showMessage('Vänligen välj en art eller "Alla arter".', 'error'); disableButtons(false); return; }

    // 2. Determinar Geometría WKT válida (prioriza inputs manuales si son válidos)
    const wktFromInputs = validateAndGetWKTFromInputs();
    if (wktFromInputs) {
        currentWKTGeometry = wktFromInputs;
        console.log("Använder WKT från manuella koordinatfält.");
    } else if (currentWKTGeometry) { // Si inputs no válidos, pero mapa sí tiene WKT
        console.log("Manuella koordinatfält ogiltiga/tomma, använder WKT från kartan.");
    } else { // Varken giltiga fält eller karta har geometri
        showMessage("Vänligen definiera ett giltigt område (antingen via fälten eller genom att rita på kartan).", 'error');
        disableButtons(false);
        return;
    }

    // 3. Lógica: "ALL" vs Específica -> Llamar a fetchAndShowCount
    if (speciesNameOrAll === "ALL") {
        currentSpeciesKey = "ALL";
        // Llamar a helper para obtener conteo y mostrar botón descarga
        await fetchAndShowCount("ALL", "Alla arter");
    } else {
        // Específica: Primero verificar existencia
        try {
            showMessage(`Verifierar art: ${speciesNameOrAll}...`, 'info');
            const checkResponse = await fetch('/check-species', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: currentUsername, password: currentPassword, speciesName: speciesNameOrAll }),
            });
            const checkData = await checkResponse.json();
            if (checkResponse.status === 401 || checkResponse.status === 403) {
                showMessage('Fel: Ogiltigt användarnamn eller lösenord. Kontrollera dina uppgifter.', 'error');
                disableButtons(false);
                return;
            }
            if (!checkResponse.ok) throw new Error(checkData.error || `Fel vid verifiering (${checkResponse.status})`);

            if (checkData.exists) {
                currentSpeciesKey = checkData.speciesKey; // Guardar clave numérica
                // Especie existe -> obtener conteo
                await fetchAndShowCount(currentSpeciesKey, checkData.scientificName); // Llamar a helper
            } else {
                showMessage('Art inte hittad i GBIF.', 'error');
                disableButtons(false); // Habilitar botones, verificación falló
            }
        } catch (error) {
            console.error('Error verifying species:', error);
            showMessage(`Fel vid artverifiering: ${error.message}`, 'error');
            disableButtons(false); // Habilitar botones, verificación falló
        }
    }
    // Nota: disableButtons(false) ahora se llama DENTRO de fetchAndShowCount o en los catch de error
});

// --- Función Helper para Obtener Conteo y Actualizar UI ---
async function fetchAndShowCount(speciesKeyForCount, displayName) {
    try {
        showMessage(`Hämtar antal förekomster för ${displayName}...`, 'info');
        disableButtons(true); // Asegurar que estén deshabilitados

        const countResponse = await fetch('/get-occurrence-count', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: currentUsername,
                password: currentPassword,
                speciesKey: speciesKeyForCount,
                geometry: currentWKTGeometry,
                basisOfRecord: currentBasisOfRecord
            })
        });
           const countData = await countResponse.json();
           if (countResponse.status === 401 || countResponse.status === 403) {
              showMessage('Fel: Ogiltigt användarnamn eller lösenord. Kontrollera dina uppgifter.', 'error');
              throw new Error('Autentisering misslyckades');
           }
           if (!countResponse.ok || !countData.success) {
               throw new Error(countData.error || countData.details?.message || `Fel vid hämtning av antal (${countResponse.status})`);
           }

        // Éxito al obtener conteo
        const count = countData.count;
        const formattedCount = count.toLocaleString('sv-SE'); // Formato sueco

        showMessage(`Filter inställda. Redo att ladda ner data.`, 'success'); // Mensaje principal más corto
        // Actualizar texto junto al botón de descarga para incluir conteo
        foundSpeciesName.innerHTML = `${displayName} <span style="font-weight:normal;">(ca ${formattedCount} förekomster)</span>`;
        downloadSection.style.display = 'block'; // Mostrar sección de descarga

    } catch (error) {
        console.error("Error fetching occurrence count:", error);
        // Mostrar error específico sobre el conteo
        showMessage(`Kunde inte hämta antal förekomster: ${error.message}. Du kan försöka starta nedladdningen ändå.`, 'error');
        // AÚN ASÍ MOSTRAR BOTÓN DE DESCARGA? Opcional. Decidimos mostrarlo.
        foundSpeciesName.textContent = displayName + " (antal okänt)"; // Indicar que el conteo falló
        downloadSection.style.display = 'block';
        // Guardar la clave de especie aunque el conteo falle (ya fue verificada o es "ALL")
        currentSpeciesKey = speciesKeyForCount;


    } finally {
        // Habilitar botones DESPUÉS del intento de obtener conteo
        disableButtons(false);
    }
}

// --- Event Listener para el botón de descarga ---
downloadBtn.addEventListener('click', async () => {
    // Verificar aceptación de licensvillkor för GBIF innan starta nedladdning
    if (acceptGbifCheckbox && !acceptGbifCheckbox.checked) {
        showMessage('Du måste godkänna licensvillkoren för GBIF-data innan du startar nedladdningen.', 'error');
        return;
    }

    // Validar que la información ESENCIAL esté lista (WKT y SpeciesKey sí deben estar)
    if (currentSpeciesKey === null || !currentWKTGeometry || !currentUsername || !currentPassword) {
        // BasisOfRecord puede ser "" (null aquí significa que ni siquiera se guardó)
        showMessage('Nödvändig information saknas (art/ALLA, område). Förbered/verifiera igen.', 'error');
        return;
    }
    clearMessages();
    disableButtons(true);

    try {
        // Llamada al backend /create-download
        const response = await fetch('/create-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: currentUsername,
                password: currentPassword,
                speciesKey: currentSpeciesKey,
                geometry: currentWKTGeometry,
                basisOfRecord: currentBasisOfRecord ?? "" // Enviar "" si es null
            }),
        });
        if (response.status === 401 || response.status === 403) {
            showMessage('Fel: Ogiltigt användarnamn eller lösenord. Kontrollera dina uppgifter.', 'error');
            disableButtons(false);
            return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Fel från server (${response.status})`);

        if (data.success) {
            showMessage('Nedladdningsbegäran startad korrekt.', 'success');
            downloadKeySpan.textContent = data.downloadKey;
            downloadInfo.style.display = 'block';
            downloadSection.style.display = 'none';
        } else {
             throw new Error(data.error || 'Servern indikerade ett fel vid skapandet av nedladdningen.');
        }
    } catch (error) {
        console.error('Fel vid skapande av nedladdning:', error);
        showMessage(`Fel vid skapande av nedladdning: ${error.message}`, 'error');
    } finally {
        disableButtons(false);
    }
});


// --- Funciones Auxiliares ---
function showMessage(message, type = 'info') {
    const g = document.getElementById('global-notification');
    if (g) {
        let cls = 'is-info';
        if (type === 'error') cls = 'is-danger';
        else if (type === 'success') cls = 'is-success';
        g.className = `notification ${cls}`;
        g.textContent = message;
        g.style.display = 'block';
        clearTimeout(g._hideTimeout);
        g._hideTimeout = setTimeout(() => { g.style.display = 'none'; }, 6000);
        return;
    }
    resultMessage.textContent = message;
    resultMessage.className = ''; // Limpiar clases anteriores primero
    resultMessage.style.display = 'block'; // Asegurar visibilidad
    if (type === 'success') { resultMessage.classList.add('success'); }
    else if (type === 'error') { resultMessage.classList.add('error'); }
    else { resultMessage.classList.add('info'); }
}
function clearMessages() {
    resultMessage.textContent = '';
    resultMessage.style.display = 'none';
    resultMessage.className = '';
    downloadSection.style.display = 'none';
    downloadInfo.style.display = 'none';
}
function disableButtons(disabled) {
    checkBtn.disabled = disabled;
    downloadBtn.disabled = disabled;
}

// Inicializar el mapa cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', function() {
    initializeMap();
});