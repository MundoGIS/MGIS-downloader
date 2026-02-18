/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const archiver = require('archiver');
const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
const LAN_GEOJSON_PATH = path.join(__dirname, 'data', 'lan.geojson');

const activeDownloads = new Map();

app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// --- CONFIGURACIÓN ---
const GDAL_ROOT = process.env.GDAL ? process.env.GDAL.trim() : null;
const QGIS_ROOT = process.env.QGIS ? process.env.QGIS.trim() : null;
const GDAL_BIN = QGIS_ROOT || GDAL_ROOT || '';

const GDAL_BUILDVRT_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdalbuildvrt.exe' : 'gdalbuildvrt'
);
const GDAL_GDALINFO_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdalinfo.exe' : 'gdalinfo'
);
// Path to gdal_merge.py: prefer environment override via .env (GDAL_MERGE),
// otherwise fall back to QGIS root or the legacy hard-coded path.
const GDAL_MERGE_CMD = (process.env.GDAL_MERGE && process.env.GDAL_MERGE.trim()) || (QGIS_ROOT ? path.join(QGIS_ROOT, 'apps', 'Python312', 'Scripts', 'gdal_merge.py') : 'C:/QGIS/apps/Python312/Scripts/gdal_merge.py');
console.log('GDAL_MERGE_CMD =', GDAL_MERGE_CMD);
const GDAL_TRANSLATE_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdal_translate.exe' : 'gdal_translate'
);
const GDAL_ADDO_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdaladdo.exe' : 'gdaladdo'
);
const PYTHON_CMD = QGIS_ROOT ? path.join(QGIS_ROOT, 'python-qgis-ltr.bat') : 'python';

// --- UTILIDADES ---
const logFile = path.join(__dirname, 'process.log');
function writeToLog(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    try {
        fs.appendFileSync(logFile, logMessage);
        console.log(logMessage.trim());
    } catch (error) {
        console.error("Fel vid skrivning i loggfilen:", error);
    }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function runGdalBuildVrt(targetDir, listFileName = 'filelist.txt', outputName = 'index.vrt') {
    return new Promise((resolve, reject) => {
        const exe = GDAL_BUILDVRT_CMD;
        const args = ['-input_file_list', listFileName, outputName];
        const child = spawn(exe, args, { cwd: targetDir, windowsHide: true });
        let stderr = '';

        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdalbuildvrt exited with code ${code}`));
        });
    });
}

function runGdalInfo(rasterPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(GDAL_GDALINFO_CMD, ['-stats', rasterPath], { windowsHide: true });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code !== 0) {
                return reject(new Error(stderr.trim() || `gdalinfo exited with code ${code}`));
            }

            const minMatch = stdout.match(/STATISTICS_MINIMUM=([-+0-9.eE]+)/);
            const maxMatch = stdout.match(/STATISTICS_MAXIMUM=([-+0-9.eE]+)/);
            const min = minMatch ? parseFloat(minMatch[1]) : null;
            const max = maxMatch ? parseFloat(maxMatch[1]) : null;
            if (Number.isFinite(min) && Number.isFinite(max)) {
                resolve({ min, max });
            } else {
                reject(new Error('Kunde inte läsa statistik från gdalinfo.'));
            }
        });
    });
}

function runGdalMerge(targetDir, tifFiles, outputName) {
    return new Promise((resolve, reject) => {
        // Crear lista de archivos para evitar límite de línea de comando
        const mergeListPath = path.join(targetDir, 'merge_list.txt');
        fs.writeFileSync(mergeListPath, tifFiles.join('\n'));
        
        const args = [
            '/c', PYTHON_CMD,
            GDAL_MERGE_CMD, '-o', outputName,
            '--optfile', 'merge_list.txt',
            '-co', 'COMPRESS=DEFLATE',
            '-co', 'PREDICTOR=2',
            '-co', 'TILED=YES',
            '-co', 'BIGTIFF=IF_SAFER'
        ];
        const child = spawn('cmd.exe', args, { cwd: targetDir, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdal_merge.py exited with code ${code}`));
        });
    });
}

function runGdalTranslate(targetDir, inputFile, outputFile) {
    return new Promise((resolve, reject) => {
        const args = [inputFile, outputFile, '-co', 'COMPRESS=LZW', '-co', 'TILED=YES', '-co', 'BIGTIFF=YES'];
        const child = spawn(GDAL_TRANSLATE_CMD, args, { cwd: targetDir, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdal_translate exited with code ${code}`));
        });
    });
}

function runGdalAddo(targetDir, rasterPath) {
    return new Promise((resolve, reject) => {
        const args = ['-r', 'average', rasterPath, '2', '4', '8', '16', '32'];
        const child = spawn(GDAL_ADDO_CMD, args, { cwd: targetDir, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdaladdo exited with code ${code}`));
        });
    });
}

function buildDynamicQml(minVal, maxVal, step = 5) {
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        throw new Error('Valores min/max inválidos para el estilo.');
    }

    const start = Math.floor(minVal / step) * step;
    const end = Math.ceil(maxVal / step) * step;
    const stops = [];
    for (let v = start; v <= end; v += step) {
        stops.push(Number(v.toFixed(2)));
    }
    if (stops.length < 2) {
        stops.push(start + step);
    }

    const items = stops.map((value, index) => {
        const ratio = stops.length === 1 ? 0 : index / (stops.length - 1);
        const shade = Math.round(250 - ratio * 230);
        const hex = shade.toString(16).padStart(2, '0');
        const color = `#${hex}${hex}${hex}`;
        const label = index === 0
            ? `<= ${value}`
            : index === stops.length - 1
                ? `> ${stops[index - 1]}`
                : `${stops[index - 1]} - ${value}`;
        return { value, color, label };
    }).slice(1); // skip the synthetic first entry for label logic

    const itemsXml = items.map(item =>
        `          <item label="${item.label}" value="${item.value}" color="${item.color}" alpha="255"/>`
    ).join('\n');

    return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.38" styleCategories="Symbology">
  <pipe>
    <rasterrenderer classificationMax="${end}" classificationMin="${start}" band="1" type="singlebandpseudocolor" opacity="1">
      <rastershader>
        <colorrampshader colorRampType="DISCRETE" classificationMode="2" minimumValue="${start}" maximumValue="${end}">
${itemsXml}
        </colorrampshader>
      </rastershader>
    </rasterrenderer>
  </pipe>
</qgis>`;
}

function getStacBase(apiType) {
    return apiType === 'hojd' 
        ? 'https://api.lantmateriet.se/stac-hojd/v1' 
        : 'https://api.lantmateriet.se/stac-vektor/v1';
}

function wktPolygonToGeoJSON(wkt) {
    if (!wkt || typeof wkt !== 'string' || !wkt.toUpperCase().startsWith('POLYGON((')) return null;
    try {
        const coordsString = wkt.substring(wkt.indexOf('((') + 2, wkt.indexOf('))'));
        const pairs = coordsString.split(',').map(pair => pair.trim());
        const coordinates = pairs.map(pair => {
            const [lon, lat] = pair.split(' ').map(parseFloat);
            return [lon, lat];
        });
        return { type: 'Polygon', coordinates: [coordinates] };
    } catch (e) { return null; }
}

function slugify(text) {
    if (!text) return '';
    return text
        .toString()
        .normalize('NFD')
        .replace(/[^\w\s-]/g, '')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

function normalizeGeometryPayload(rawGeometry) {
    if (!rawGeometry) return null;
    
    // Si es string, intentar convertir de WKT a GeoJSON
    if (typeof rawGeometry === 'string') {
        const geoJson = wktPolygonToGeoJSON(rawGeometry);
        console.log('[normalizeGeometryPayload] WKT convertido a GeoJSON:', JSON.stringify(geoJson));
        return geoJson;
    }
    
    // Si ya es objeto GeoJSON, validar y retornar
    if (typeof rawGeometry === 'object' && rawGeometry.type && rawGeometry.coordinates) {
        console.log('[normalizeGeometryPayload] GeoJSON recibido directamente:', JSON.stringify(rawGeometry));
        return rawGeometry;
    }
    
    console.warn('[normalizeGeometryPayload] Formato de geometría no reconocido:', typeof rawGeometry, rawGeometry);
    return null;
}

// --- VALIDACIÓN DE CREDENCIALES LMV ---
async function validateLmvCredentials(apiUsername, apiKey, apiType, collectionId) {
    const STAC_BASE = getStacBase(apiType);

    // 1) Intentar obtener al menos un item de la colección para disponer de un asset a chequear
    try {
        const searchUrl = `${STAC_BASE}/search`;
        const body = { collections: [collectionId], limit: 1 };
        const searchRes = await axios.post(searchUrl, body, { headers: { 'X-API-Key': apiKey }, timeout: 10000 });
        const features = (searchRes.data && searchRes.data.features) || [];
        if (features.length > 0) {
            const item = features[0];
            const assetKey = item.assets ? Object.keys(item.assets)[0] : null;
            const asset = assetKey ? item.assets[assetKey] : null;
            if (asset && asset.href) {
                // Construir URL absoluta si es relativa
                let assetUrl = asset.href;
                const selfLink = item.links ? item.links.find(l => l.rel === 'self') : null;
                if (selfLink && selfLink.href && !asset.href.startsWith('http')) {
                    assetUrl = new URL(asset.href, selfLink.href).href;
                }

                try {
                    // Intentar una GET parcial (Range) para forzar comprobación de permisos sin descargar todo
                    const getRes = await axios.get(assetUrl, {
                        headers: { 'X-API-Key': apiKey, 'Range': 'bytes=0-1023' },
                        auth: apiUsername && apiKey ? { username: apiUsername, password: apiKey } : undefined,
                        timeout: 10000,
                        responseType: 'stream',
                        maxRedirects: 5,
                        validateStatus: s => true
                    });
                    if (getRes.status === 401 || getRes.status === 403) {
                        return { ok: false, status: getRes.status, message: 'Unauthorized when trying to fetch asset' };
                    }
                    // 200/206/3xx are considered valid
                    return { ok: true, status: getRes.status };
                } catch (getErr) {
                    const status = getErr.response ? getErr.response.status : null;
                    try {
                        const respBody = getErr.response && getErr.response.data ? JSON.stringify(getErr.response.data).slice(0,800) : getErr.message;
                        writeToLog(`[VALIDATION] Asset GET failed for collection=${collectionId} apiType=${apiType} status=${status} detail=${respBody}`);
                    } catch (e) {
                        writeToLog(`[VALIDATION] Asset GET failed for collection=${collectionId} apiType=${apiType} status=${status} (could not stringify response)`);
                    }
                    return { ok: false, status, message: getErr.message };
                }
            }
        }
    } catch (err) {
        // Si la búsqueda falla con 401/403 interpretarlo como credenciales inválidas
        const status = err.response ? err.response.status : null;
        try {
            const respBody = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0,800) : err.message;
            writeToLog(`[VALIDATION] Search failed for collection=${collectionId} apiType=${apiType} status=${status} detail=${respBody}`);
        } catch (e) {
            writeToLog(`[VALIDATION] Search failed for collection=${collectionId} apiType=${apiType} status=${status} (could not stringify response)`);
        }
        if (status === 401 || status === 403) return { ok: false, status, message: err.message };
        // En otros errores, continuar con comprobación por collections como fallback
    }

    // Fallback: intentar acceder al endpoint de collections (si no había items)
    try {
        const testUrl = `${STAC_BASE}/collections`;
        const res = await axios.get(testUrl, {
            headers: { 'X-API-Key': apiKey },
            auth: apiUsername && apiKey ? { username: apiUsername, password: apiKey } : undefined,
            timeout: 10000
        });
        return { ok: true, status: res.status };
    } catch (err) {
        const status = err.response ? err.response.status : null;
        try {
            const respBody = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0,800) : err.message;
            writeToLog(`[VALIDATION] Collections check failed for apiType=${apiType} status=${status} detail=${respBody}`);
        } catch (e) {
            writeToLog(`[VALIDATION] Collections check failed for apiType=${apiType} status=${status} (could not stringify response)`);
        }
        return { ok: false, status, message: err.message };
    }
}

// --- RUTAS GBIF/ARTDATA ---

// Endpoint para verificar si una especie existe en GBIF
app.post('/check-species', async (req, res) => {
    const { username, password, speciesName } = req.body;
    
    if (!username || !password || !speciesName) {
        return res.status(400).json({ 
            success: false, 
            error: 'Faltan parámetros: username, password y speciesName son requeridos' 
        });
    }

    try {
        // Sök art i GBIF Species API
        const searchUrl = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(speciesName)}`;
        const response = await axios.get(searchUrl, {
            auth: { username, password }
        });

        if (response.data && response.data.usageKey) {
            res.json({
                success: true,
                exists: true,
                speciesKey: response.data.usageKey,
                scientificName: response.data.scientificName || speciesName,
                rank: response.data.rank,
                status: response.data.status
            });
        } else {
            res.json({
                success: true,
                exists: false
            });
        }
    } catch (error) {
        console.error('Fel vid verifiering av art:', error.message);
        res.status(500).json({
            success: false,
            error: 'Fel vid verifiering av art i GBIF',
            details: error.message
        });
    }
});

// Endpoint para obtener el conteo de ocurrencias en GBIF
app.post('/get-occurrence-count', async (req, res) => {
    const { username, password, speciesKey, geometry, basisOfRecord } = req.body;
    
    if (!username || !password || !speciesKey) {
        return res.status(400).json({ 
            success: false, 
            error: 'Saknas parametrar: username, password och speciesKey krävs' 
        });
    }

    try {
        // Construir URL de búsqueda de ocurrencias
        let searchUrl = 'https://api.gbif.org/v1/occurrence/search?limit=0';
        
        // Agregar taxonKey (o ALL)
        if (speciesKey !== 'ALL') {
            searchUrl += `&taxonKey=${speciesKey}`;
        }
        
        // Agregar basisOfRecord si está especificado
        if (basisOfRecord) {
            searchUrl += `&basisOfRecord=${basisOfRecord}`;
        }
        
        // Agregar geometría si está especificada
        if (geometry) {
            // Convertir WKT a bbox o geometry parameter
            // GBIF acepta geometry en formato WKT
            const wktString = typeof geometry === 'string' ? geometry : JSON.stringify(geometry);
            searchUrl += `&geometry=${encodeURIComponent(wktString)}`;
        }

        const response = await axios.get(searchUrl, {
            auth: { username, password }
        });

        if (response.data && typeof response.data.count === 'number') {
            res.json({
                success: true,
                count: response.data.count
            });
        } else {
            res.json({
                success: false,
                error: 'No se pudo obtener el conteo de ocurrencias'
            });
        }
    } catch (error) {
        console.error('Fel vid hämtning av förekomstantal:', error.message);
        res.status(500).json({
            success: false,
            error: 'Fel vid hämtning av förekomstantal från GBIF',
            details: error.message
        });
    }
});

// Endpoint para crear una descarga en GBIF
app.post('/create-download', async (req, res) => {
    const { username, password, speciesKey, geometry, basisOfRecord } = req.body;
    
    if (!username || !password || !speciesKey || !geometry) {
        return res.status(400).json({ 
            success: false, 
            error: 'Saknas obligatoriska parametrar' 
        });
    }

    try {
        // Construir el predicado de descarga de GBIF
        const downloadRequest = {
            creator: username,
            notificationAddresses: [username],
            sendNotification: true,
            format: "SIMPLE_CSV",
            predicate: {
                type: "and",
                predicates: []
            }
        };

        // Agregar filtro de especie
        if (speciesKey !== 'ALL') {
            downloadRequest.predicate.predicates.push({
                type: "equals",
                key: "TAXON_KEY",
                value: speciesKey
            });
        }

        // Agregar filtro de basisOfRecord
        if (basisOfRecord) {
            downloadRequest.predicate.predicates.push({
                type: "equals",
                key: "BASIS_OF_RECORD",
                value: basisOfRecord
            });
        }

        // Agregar filtro de geometría
        if (geometry) {
            downloadRequest.predicate.predicates.push({
                type: "within",
                geometry: typeof geometry === 'string' ? geometry : JSON.stringify(geometry)
            });
        }

        // Simplificar si solo hay un predicado
        if (downloadRequest.predicate.predicates.length === 1) {
            downloadRequest.predicate = downloadRequest.predicate.predicates[0];
        }

        // Crear la descarga en GBIF
        const response = await axios.post(
            'https://api.gbif.org/v1/occurrence/download/request',
            downloadRequest,
            {
                auth: { username, password },
                headers: { 'Content-Type': 'application/json' }
            }
        );

        res.json({
            success: true,
            downloadKey: response.data,
            message: 'Nedladdning skapad i GBIF'
        });

    } catch (error) {
        console.error('Fel vid skapande av nedladdning:', error.message);
        res.status(500).json({
            success: false,
            error: 'Fel vid skapande av nedladdning i GBIF',
            details: error.response?.data || error.message
        });
    }
});

// --- RUTAS DE COLECCIONES ---

// Ruta original para Vektor (usada por lmv.html)
app.get('/lmv/collections', async (req, res) => {
    try {
        const response = await axios.get('https://api.lantmateriet.se/stac-vektor/v1/collections');
        res.json({ success: true, collections: response.data.collections });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// NUEVA Ruta para Höjd (usada por lmv_hojd.html)
app.get('/lmv/hojd/collections', async (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(401).json({ success: false, error: 'API Key requerida en el header X-API-Key' });
        }
        
        const response = await axios.get('https://api.lantmateriet.se/stac-hojd/v1/collections', {
            headers: { 'X-API-Key': apiKey }
        });
        res.json({ success: true, collections: response.data.collections });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/lmv/lan', (req, res) => {
    fs.readFile(LAN_GEOJSON_PATH, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Kunde inte läsa län-data.' });
        }
        try {
            const json = JSON.parse(data);
            res.json({ success: true, data: json });
        } catch (parseErr) {
            res.status(500).json({ success: false, error: 'Län-GeoJSON är ogiltig.' });
        }
    });
});

// --- LÓGICA DE DESCARGA ---

async function fetchDownloadAndUnzipAll(apiKey, apiUsername, collectionId, apiType, geometry, geometryLabel = null, abortSignal = null) {
    const STAC_BASE = getStacBase(apiType);
    const slugFromLabel = geometryLabel ? slugify(geometryLabel) : '';
    const areaSlug = slugFromLabel || (geometryLabel ? 'omrade' : '');
    const folderSuffix = areaSlug ? `_${areaSlug}` : '';
    const downloadFolderName = `LMV_DOWNLOADS_${collectionId}${folderSuffix}`;
    const vrtBaseName = areaSlug ? `index_${areaSlug}` : 'index';
    const vrtFileName = `${vrtBaseName}.vrt`;
    const folderAlreadyExists = fs.existsSync(downloadFolderName);
    if (folderAlreadyExists) {
        try {
            const existingTifs = fs.readdirSync(downloadFolderName)
                .filter(name => name.toLowerCase().endsWith('.tif') || name.toLowerCase().endsWith('.tiff'));
            if (existingTifs.length > 0) {
                writeToLog(`[${collectionId}] Mappen finns redan (${downloadFolderName}) med ${existingTifs.length} raster. Hoppar över ny nedladdning.`);
                return;
            }
        } catch (err) {
            console.warn(`[${collectionId}] Kunde inte inspektera befintlig mapp: ${err.message}`);
        }
    }
    const maxRetries = 5;
    
    // CAMBIO 1: Ahora guardamos objetos completos, no solo URLs
    let downloadQueue = []; 
    
    let searchRequestBody = { collections: [collectionId], limit: 1000 };
    
    if (geometry) {
        const geoJson = normalizeGeometryPayload(geometry);
        if (geoJson) {
            searchRequestBody.intersects = geoJson;
            writeToLog(`[${collectionId}] Búsqueda con geometría: ${JSON.stringify(geoJson)}`);
        } else {
            console.warn(`[${collectionId}] Geometría inválida ignorada.`);
            writeToLog(`[${collectionId}] Geometría inválida ignorada: ${JSON.stringify(geometry)}`);
        }
    } else {
        writeToLog(`[${collectionId}] Búsqueda sin filtro geométrico (toda Suecia).`);
    }

    let nextUrl = `${STAC_BASE}/search`;
    writeToLog(`[${collectionId}] (${apiType}) Startar sökning/paginering...`);

    // 1. PAGINACIÓN
    while (nextUrl) {
        if (abortSignal && abortSignal.aborted) {
            writeToLog(`[${collectionId}] Nedladdning avbröts av användaren.`);
            return;
        }
        try {
            const config = { headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' } };
            let response;
            
            if (nextUrl === `${STAC_BASE}/search`) {
                response = await axios.post(nextUrl, searchRequestBody, config);
            } else {
                response = await axios.get(nextUrl, config);
            }

            const items = response.data.features || [];
            writeToLog(`[${collectionId}] Sida mottagen: ${items.length} objekt hittades.`);
            items.forEach(item => {
                if (!item.assets) {
                    writeToLog(`[${collectionId}] Objekt utan assets: ${item.id || 'utan ID'}`);
                    return;
                }
                
                let assetsFound = 0;
                Object.keys(item.assets).forEach(key => {
                    const asset = item.assets[key];
                    if (!asset.href) return;

                    const hrefLower = asset.href.toLowerCase();
                    
                    // Para datos vectoriales: aceptar gpkg, geojson, gml, shp
                    const isVector = hrefLower.endsWith('.gpkg') || hrefLower.endsWith('.geojson') || 
                                    hrefLower.endsWith('.gml') || hrefLower.endsWith('.zip') ||
                                    hrefLower.includes('.gpkg?') || hrefLower.includes('.geojson?');
                    
                    // Para datos raster: aceptar tif/tiff
                    const isRaster = hrefLower.endsWith('.tif') || hrefLower.endsWith('.tiff');
                    
                    if (!isVector && !isRaster) return;

                    const selfLink = item.links ? item.links.find(link => link.rel === 'self') : null;
                    let absoluteUrl = asset.href;
                    if (selfLink && selfLink.href && !asset.href.startsWith('http')) {
                        absoluteUrl = new URL(asset.href, selfLink.href).href;
                    }

                    downloadQueue.push({
                        url: absoluteUrl,
                        bbox: item.bbox,
                        id: item.id,
                        assetKey: key,
                        type: isVector ? 'vector' : 'raster'
                    });
                    assetsFound++;
                });
                
                if (assetsFound === 0) {
                    writeToLog(`[${collectionId}] Objekt ${item.id || 'utan ID'} har inga nedladdningsbara assets. Tillgängliga assets: ${Object.keys(item.assets).join(', ')}`);
                }
            });

            const nextLink = response.data.links ? response.data.links.find(link => link.rel === 'next') : null;
            nextUrl = nextLink ? nextLink.href : null;
            
            await delay(500); 

        } catch (error) {
            if (error.response && error.response.status === 429) {
                writeToLog(`[${collectionId}] Rate limit (429) vid paginering. Väntar 10s...`);
                await delay(10000);
                continue; 
            }
            writeToLog(`[${collectionId}] Fel vid paginering: ${error.message}. Avbryter sökning.`);
            nextUrl = null;
        }
    }

    // Ta bort dubbletter baserat på URL
    downloadQueue = downloadQueue.filter((v,i,a)=>a.findIndex(t=>(t.url===v.url))===i);

    if (downloadQueue.length > 0) {
        writeToLog(`[${collectionId}] KLART! Hittade ${downloadQueue.length} filer att ladda ner.`);
    } else {
        writeToLog(`[${collectionId}] Inga resultat för given geometri. Fortsätter med nästa samling.`);
        return;
    }

    if (!folderAlreadyExists) fs.mkdirSync(downloadFolderName, { recursive: true });

    // Array para guardar las features del GeoJSON final
    let tileIndexFeatures = [];

    // 2. DESCARGA
    for (let i = 0; i < downloadQueue.length; i++) {
        if (abortSignal && abortSignal.aborted) {
            writeToLog(`[${collectionId}] Descarga cancelada por el usuario.`);
            return;
        }
        const itemData = downloadQueue[i];
        const url = itemData.url;
        const filename = path.basename(new URL(url).pathname);
        const filePath = path.join(downloadFolderName, filename);
        
        await delay(1000); 

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (!fs.existsSync(filePath)) {
                    const httpAgent = new http.Agent({ keepAlive: false });
                    const response = await axios({
                        method: 'GET', url, responseType: 'stream', httpAgent, timeout: 60000,
                        auth: { username: apiUsername, password: apiKey }
                    });
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });
                    console.log(`[${i+1}/${downloadQueue.length}] Nedladdad: ${filename}`);
                } else {
                    console.log(`[${i+1}/${downloadQueue.length}] Finns redan: ${filename}`);
                }

                // Si es ZIP, descomprimimos
                if (filename.toLowerCase().endsWith('.zip')) {
                    await fs.createReadStream(filePath)
                        .pipe(unzipper.Extract({ path: downloadFolderName }))
                        .promise();
                    try { fs.unlinkSync(filePath); } catch(e){}
                }

                // CAMBIO 3: Preparar Feature para el Tile Index
                // Solo si tenemos bbox válido
                if (itemData.bbox && itemData.bbox.length === 4) {
                    const [minx, miny, maxx, maxy] = itemData.bbox;
                    tileIndexFeatures.push({
                        type: "Feature",
                        properties: {
                            id: itemData.id,
                            filename: filename,
                            // Ruta relativa para que QGIS la encuentre fácil si mueves la carpeta
                            location: `./${filename}` 
                        },
                        geometry: {
                            type: "Polygon",
                            coordinates: [[
                                [minx, miny],
                                [maxx, miny],
                                [maxx, maxy],
                                [minx, maxy],
                                [minx, miny]
                            ]]
                        }
                    });
                }

                break; 
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    const waitTime = 30000;
                    console.warn(`[${collectionId}] 429 Rate Limit. Esperando ${waitTime/1000}s...`);
                    await delay(waitTime);
                } else {
                    console.warn(`[${collectionId}] Fel vid nedladdning ${filename}: ${error.message}. Försök ${attempt}/${maxRetries}`);
                    await delay(2000 * attempt);
                }
            }
        }
    }

    // CAMBIO 4: Generar archivo tile_index.geojson
    if (tileIndexFeatures.length > 0) {
        const geoJSON = {
            type: "FeatureCollection",
            name: `TileIndex_${collectionId}`,
            crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
            features: tileIndexFeatures
        };
        
        const indexFile = path.join(downloadFolderName, 'tile_index.geojson');
        try {
            fs.writeFileSync(indexFile, JSON.stringify(geoJSON, null, 2));
            writeToLog(`[${collectionId}] Tile Index genererat: ${indexFile}`);
        } catch (err) {
            console.error(`Error escribiendo tile index: ${err.message}`);
        }
    }

    // POST-PROCESAMIENTO: Merge + Overviews + VRT + Estilo
    try {
        const tifFiles = fs.readdirSync(downloadFolderName)
            .filter(name => name.toLowerCase().endsWith('.tif') || name.toLowerCase().endsWith('.tiff'))
            .sort();

        if (tifFiles.length > 0) {
            writeToLog(`[${collectionId}] Startar efterbearbetning: sammanslagning av ${tifFiles.length} tiles...`);
            
            const mergedFileName = `merged_${vrtBaseName}.tif`;
            const mergedPath = path.join(downloadFolderName, mergedFileName);
            
            try {
                // 1. Merge todos los tiles en un solo GeoTIFF
                await runGdalMerge(downloadFolderName, tifFiles, mergedFileName);
                writeToLog(`[${collectionId}] Sammanfogning klar: ${mergedFileName}`);
                
                // 2. Remover tiles originales
                writeToLog(`[${collectionId}] Tar bort ${tifFiles.length} ursprungliga tiles...`);
                tifFiles.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(downloadFolderName, file));
                    } catch (e) {
                        console.warn(`Kunde inte ta bort ${file}: ${e.message}`);
                    }
                });
                
                // 3. Construir overviews (pirámides)
                writeToLog(`[${collectionId}] Skapar översiktsnivåer (gdaladdo -r average)...`);
                await runGdalAddo(downloadFolderName, mergedFileName);
                writeToLog(`[${collectionId}] Översikter färdiga.`);
                
                // 4. Generar VRT apuntando al merged
                const listPath = path.join(downloadFolderName, 'filelist.txt');
                fs.writeFileSync(listPath, mergedFileName);
                await runGdalBuildVrt(downloadFolderName, 'filelist.txt', vrtFileName);
                writeToLog(`[${collectionId}] VRT genererat: ${vrtFileName}`);
                
                // 5. Generar estilo dinámico
                try {
                    const stats = await runGdalInfo(mergedPath);
                    const qmlContent = buildDynamicQml(stats.min, stats.max, 5);
                    const qmlPath = path.join(downloadFolderName, `${vrtFileName}.qml`);
                    fs.writeFileSync(qmlPath, qmlContent, 'utf8');
                    writeToLog(`[${collectionId}] Dynamisk stil applicerad (intervall om 5 enheter).`);
                } catch (styleErr) {
                    console.warn(`[${collectionId}] Kunde inte generera stil: ${styleErr.message}`);
                }
            } catch (postErr) {
                console.warn(`[${collectionId}] Fel i efterbearbetning: ${postErr.message}`);
            }
        }
    } catch (vrtErr) {
        console.error(`Det gick inte att förbereda efterbearbetning för ${collectionId}: ${vrtErr.message}`);
    }

    writeToLog(`[${collectionId}] Processen slutförd.`);
}

// --- RUTA DE INICIO DE DESCARGA ---
app.post('/lmv/start-full-download', async (req, res) => {
    const { apiKey, apiUsername, collectionId, apiType, geometry, geometryLabel } = req.body;

    // Standardvärde: om apiType saknas används 'vektor' (bakåtkompatibilitet)
    const type = apiType || 'vektor';

    if (!apiKey || !collectionId) return res.status(400).json({ success: false, error: 'Saknas data.' });

    // Validar credenciales antes de iniciar cualquier proceso en background
    try {
        const valid = await validateLmvCredentials(apiUsername, apiKey, type, collectionId);
        if (!valid.ok) {
            const status = valid.status || 401;
            writeToLog(`[VALIDATION] Felaktiga LMV-uppgifter (status: ${status}). Avbryter start.`);
            return res.status(401).json({ success: false, error: 'Ogiltigt användarnamn eller API-nyckel mot Lantmäteriet. Kontrollera dina uppgifter.' });
        }
    } catch (e) {
        writeToLog(`[VALIDATION] Fel vid validering av LMV-uppgifter: ${e.message}`);
        return res.status(502).json({ success: false, error: 'Fel vid kontakt med LMV API. Försök senare.' });
    }

    // Crear identificador y controlador solo después de validar
    const downloadId = `${type}_${collectionId}_${geometryLabel || 'default'}_${Date.now()}`;
    const abortController = new AbortController();
    activeDownloads.set(downloadId, abortController);

    // LÓGICA ESPECIAL: Descargar TODAS las Markhöjdmodell
        // ...existing code...
        // LÓGICA ESPECIAL: Descargar TODAS las Markhöjdmodell (o filtrar por área en todas)
        if (type === 'hojd' && collectionId === 'ALL_MARKHOJD') {
            
            let msg = 'Söker Markhöjdmodell-data... (Detta kan ta några minuter)';
            res.status(202).json({ success: true, message: msg, downloadId });
            
            (async () => {
                try {
                    const listRes = await axios.get('https://api.lantmateriet.se/stac-hojd/v1/collections', {
                        headers: { 'X-API-Key': apiKey }
                    });
                    const markhojdCols = listRes.data.collections.filter(col => 
                        col.id.toLowerCase().includes('markhojd') || col.title.toLowerCase().includes('markhöjd')
                    );
                    
                    writeToLog(`[ALL_MARKHOJD] Startar skanning av ${markhojdCols.length} samlingar för valt område.`);

                    // NUEVO: procesar estrictamente en serie + logs detallados
                    let processed = 0;
                    for (const col of markhojdCols) {
                        if (abortController.signal.aborted) {
                            writeToLog(`[ALL_MARKHOJD] Processen avbröts av användaren.`);
                            break;
                        }
                        processed++;
                        writeToLog(`[ALL_MARKHOJD] (${processed}/${markhojdCols.length}) -> ${col.id} — startar hämtning.`);
                        try {
                            await fetchDownloadAndUnzipAll(apiKey, apiUsername, col.id, 'hojd', geometry, geometryLabel, abortController.signal);
                            writeToLog(`[ALL_MARKHOJD] (${col.id}) slutförd.`);
                        } catch (err) {
                            writeToLog(`[ALL_MARKHOJD] (${col.id}) misslyckades: ${err.message}`);
                        }
                        await delay(2000); // pausa entre colecciones
                    }

                    writeToLog(`[ALL_MARKHOJD] SKANNING SLUTFÖRD! Kontrollera nedladdningsmappen.`);
                } catch (err) {
                    writeToLog(`[ALL_MARKHOJD] Kritiskt fel: ${err.message}`);
                } finally {
                    activeDownloads.delete(downloadId);
                }
            })();
            return;
        }

    // Normal logik (en enda samling)
    res.status(202).json({ success: true, message: `Process startad för '${collectionId}'.`, downloadId });
    fetchDownloadAndUnzipAll(apiKey, apiUsername, collectionId, type, geometry, geometryLabel, abortController.signal)
        .catch(err => console.error(`[${collectionId}] Error tarea fondo:`, err))
        .finally(() => activeDownloads.delete(downloadId));
});
app.post('/lmv/cancel-download', (req, res) => {
    const { downloadId } = req.body;
    if (!downloadId) {
        return res.status(400).json({ success: false, error: 'downloadId krävs' });
    }
    const controller = activeDownloads.get(downloadId);
    if (controller) {
        controller.abort();
        activeDownloads.delete(downloadId);
        writeToLog(`[CANCEL] Nedladdning avbröts: ${downloadId}`);
        res.json({ success: true, message: 'Nedladdning avbröts.' });
    } else {
        res.json({ success: false, error: 'Nedladdning hittades inte eller är redan slutförd.' });
    }
});

// --- GESTIÓN DE DESCARGAS ---
app.get('/lmv/downloads/list', (req, res) => {
    try {
        const entries = fs.readdirSync(__dirname, { withFileTypes: true });
        const downloads = entries
            .filter(entry => entry.isDirectory() && entry.name.startsWith('LMV_DOWNLOADS_'))
            .map(entry => {
                const folderPath = path.join(__dirname, entry.name);
                const stats = fs.statSync(folderPath);
                const files = fs.readdirSync(folderPath);
                
                // Calcular tamaño total
                let totalSize = 0;
                files.forEach(file => {
                    try {
                        const filePath = path.join(folderPath, file);
                        const fileStats = fs.statSync(filePath);
                        if (fileStats.isFile()) totalSize += fileStats.size;
                    } catch (e) {}
                });
                
                // Detectar archivos importantes
                const hasMerged = files.some(f => f.startsWith('merged_') && f.endsWith('.tif'));
                const hasVrt = files.some(f => f.endsWith('.vrt'));
                const hasTileIndex = files.includes('tile_index.geojson');
                const tifCount = files.filter(f => f.toLowerCase().endsWith('.tif') || f.toLowerCase().endsWith('.tiff')).length;
                
                return {
                    name: entry.name,
                    created: stats.birthtime,
                    modified: stats.mtime,
                    size: totalSize,
                    fileCount: files.length,
                    tifCount,
                    hasMerged,
                    hasVrt,
                    hasTileIndex
                };
            })
            .sort((a, b) => b.modified - a.modified);
        
        res.json({ success: true, downloads });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/lmv/downloads/download/:folderName', (req, res) => {
    const folderName = req.params.folderName;
    if (!folderName.startsWith('LMV_DOWNLOADS_')) {
        return res.status(400).json({ success: false, error: 'Ogiltigt mappnamn' });
    }
    
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        return res.status(404).json({ success: false, error: 'Mapp hittades inte' });
    }
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', err => {
        console.error('Fel vid skapande av ZIP:', err);
        res.status(500).end();
    });
    
    archive.pipe(res);
    archive.directory(folderPath, folderName);
    archive.finalize();
});

app.delete('/lmv/downloads/delete/:folderName', (req, res) => {
    const folderName = req.params.folderName;
    if (!folderName.startsWith('LMV_DOWNLOADS_')) {
        return res.status(400).json({ success: false, error: 'Ogiltigt mappnamn' });
    }
    
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ success: false, error: 'Mapp hittades inte' });
    }
    
    try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        writeToLog(`[DELETE] Mapp raderad: ${folderName}`);
        res.json({ success: true, message: 'Mappen raderades' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Servern körs på http://localhost:${port}`);
    console.log(`- Vektor:    http://localhost:${port}/lmv.html`);
    console.log(`- Höjd:      http://localhost:${port}/lmv_hojd.html`);
    console.log(`- Nedladdningar: http://localhost:${port}/downloads.html`);
});
// Endpoint para validar LMV-uppgifter rápidamente desde el cliente
app.post('/lmv/validate', async (req, res) => {
    const { apiKey, apiUsername, collectionId, apiType } = req.body;
    const type = apiType || 'vektor';
    if (!apiKey || !collectionId) return res.status(400).json({ success: false, error: 'Saknas data.' });

    try {
        const valid = await validateLmvCredentials(apiUsername, apiKey, type, collectionId);
        if (!valid.ok) {
            const status = valid.status || 401;
            writeToLog(`[VALIDATE-ENDPOINT] Validering misslyckades (status: ${status}) för samling ${collectionId}`);
            return res.status(401).json({ success: false, error: 'Ogiltigt användarnamn eller API-nyckel mot Lantmäteriet. Kontrollera dina uppgifter.' });
        }
        return res.json({ success: true, message: 'Validering OK' });
    } catch (e) {
        writeToLog(`[VALIDATE-ENDPOINT] Fel vid validering: ${e.message}`);
        return res.status(502).json({ success: false, error: 'Fel vid kontakt med LMV API. Försök senare.' });
    }
});