/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */
require('dotenv').config();
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const { randomUUID, randomBytes, createHash } = require('crypto');
const archiver = require('archiver');
const { installAuth } = require('./auth');
const { MAX_ZOOM, overzoomTile } = require('./terrain-tiles');
const { createTerrainTileRenderer, maxZoomForResolution, overzoomRenderedTile } = require('./terrain-renderer');
const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3004;
const LAN_GEOJSON_PATH = path.join(__dirname, 'data', 'lan.geojson');

const jobs = new Map();
const FINISHED_JOB_TTL_MS = 12 * 60 * 60 * 1000;
const TERRAIN_CATALOGS_FILE = path.join(__dirname, 'terrain_catalogs.json');
const TERRAIN_PUBLIC_ROOT = path.join(__dirname, 'terrain');
const TERRAIN_SOURCE_ROOT = path.join(__dirname, 'terrain-sources');
const TERRAIN_CACHE_ROOT = path.join(__dirname, 'terrain-cache');
const DEFAULT_TERRAIN_RESOLUTION = 10;
const ALLOWED_TERRAIN_RESOLUTIONS = new Set([10, 20, 50, 100]);
const activePublications = new Set();
const publicationJobs = new Map();

app.use(bodyParser.json({ limit: '50mb' }));
app.set('trust proxy', 'loopback');
installAuth(app, { getCatalog: alias => loadPublishedCatalogs()[alias] });
app.use(express.static('public'));
const downloadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

function ensureTerrainCatalogStore() {
    try {
        fs.mkdirSync(TERRAIN_PUBLIC_ROOT, { recursive: true });
        fs.mkdirSync(TERRAIN_SOURCE_ROOT, { recursive: true });
        fs.mkdirSync(TERRAIN_CACHE_ROOT, { recursive: true });
    } catch (e) {
        console.warn('[TERRAIN] Kunde inte skapa katalogroot:', e.message);
    }

    try {
        if (!fs.existsSync(TERRAIN_CATALOGS_FILE)) {
            fs.writeFileSync(TERRAIN_CATALOGS_FILE, JSON.stringify({}, null, 2));
        }
    } catch (e) {
        console.warn('[TERRAIN] Kunde inte skapa katalogindex:', e.message);
    }
}

function normalizeCatalogAlias(value) {
    const raw = String(value || '').trim().toLowerCase();
    const normalized = raw.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    return normalized || 'catalog';
}

function loadPublishedCatalogs() {
    ensureTerrainCatalogStore();
    try {
        const raw = fs.readFileSync(TERRAIN_CATALOGS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        writeToLog(`[TERRAIN] Kunde inte läsa katalogindex: ${error.message}`);
        return {};
    }
}

function savePublishedCatalogs(catalogs) {
    ensureTerrainCatalogStore();
    try {
        fs.writeFileSync(TERRAIN_CATALOGS_FILE, JSON.stringify(catalogs, null, 2));
    } catch (error) {
        writeToLog(`[TERRAIN] Kunde inte spara katalogindex: ${error.message}`);
        throw error;
    }
}

function newServiceKey() {
    const key = randomBytes(32).toString('hex');
    return { key, hash: createHash('sha256').update(key).digest('hex') };
}

function removePublishedCatalogs(catalogs, aliases) {
    const outputs = aliases.filter(alias => catalogs[alias]).map(alias => {
        const entry = catalogs[alias];
        const output = path.resolve(entry.publicFolder || path.join(TERRAIN_PUBLIC_ROOT, alias));
        if (!output.startsWith(TERRAIN_PUBLIC_ROOT + path.sep)) {
            throw new Error('Ogiltig publiceringsmapp: ' + alias);
        }
        return { alias, output };
    });
    for (const { alias, output } of outputs) {
        const entry = catalogs[alias];
        fs.rmSync(output, { recursive: true, force: true });
        removeCatalogGeneratedFiles(entry);
        delete catalogs[alias];
    }
    savePublishedCatalogs(catalogs);
}

function safeJoinWithinBase(basePath, ...parts) {
    const target = path.resolve(basePath, ...parts);
    if (target !== basePath && !target.startsWith(basePath + path.sep)) {
        throw new Error('Ogiltig katalogsökväg');
    }
    return target;
}

function removeCatalogGeneratedFiles(entry) {
    const generated = entry.generated || {};
    if (generated.cacheKey && /^[a-f0-9-]{36}$/i.test(generated.cacheKey)) {
        fs.rmSync(path.join(TERRAIN_CACHE_ROOT, generated.cacheKey), { recursive: true, force: true });
    }
    if (generated.sourceManaged && generated.sourceRaster) {
        const source = path.resolve(generated.sourceRaster);
        if (source.startsWith(TERRAIN_SOURCE_ROOT + path.sep)) fs.rmSync(source, { force: true });
    }
}

function runGdalCommand(exePath, args, cwd = null) {
    return new Promise((resolve, reject) => {
        if (!exePath || !fs.existsSync(exePath)) {
            return reject(new Error(`Falta el ejecutable GDAL: ${exePath || '<no definido>'}. Revisa GDAL/QGIS en .env.`));
        }

        const child = spawn(exePath, args, { cwd: cwd || __dirname, windowsHide: true, env: GDAL_ENV });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve({ stdout, stderr });
            reject(new Error(stderr.trim() || stdout.trim() || `GDAL process exited with code ${code}`));
        });
    });
}

function validateGdalBinarySet() {
    const required = [
        { name: 'gdalbuildvrt', path: GDAL_BUILDVRT_CMD },
        { name: 'gdalinfo', path: GDAL_GDALINFO_CMD },
        { name: 'gdal_translate', path: GDAL_TRANSLATE_CMD },
        { name: 'gdalwarp', path: GDAL_WARP_CMD },
        { name: 'gdaldem', path: GDAL_DEM_CMD }
    ];

    const missing = required.filter(item => !item.path || !fs.existsSync(item.path));
    if (missing.length) {
        const message = `FALTAN BINARIOS GDAL: ${missing.map(item => item.name).join(', ')}. Revisa GDAL/QGIS en .env.`;
        console.error(message);
        return { ok: false, message, missing };
    }

    return { ok: true, message: 'GDAL OK', missing: [] };
}

async function publishTerrainRasterFolder(folderName, alias, hillshadeStyle = { altitude: 35, strength: 1.7 }) {
    const sourceRoot = path.join(__dirname, folderName);
    fs.mkdirSync(TERRAIN_PUBLIC_ROOT, { recursive: true });
    fs.mkdirSync(TERRAIN_SOURCE_ROOT, { recursive: true });
    const publicationId = `${alias}-${Date.now()}-${randomUUID()}`;
    const outDir = path.join(TERRAIN_PUBLIC_ROOT, publicationId);
    fs.mkdirSync(outDir, { recursive: true });

    let sourcePath;
    let sourceManaged = false;
    try {
        const vrtFiles = fs.readdirSync(sourceRoot).filter(file => /\.vrt$/i.test(file)).sort();
        const preferredVrt = vrtFiles.find(file => file.toLowerCase() === 'index.vrt');
        const rasterFiles = fs.readdirSync(sourceRoot).filter(file => /\.tiff?$/i.test(file)).sort();
        if (preferredVrt) {
            sourcePath = path.join(sourceRoot, preferredVrt);
        } else if (rasterFiles.length) {
            sourcePath = path.join(TERRAIN_SOURCE_ROOT, `${publicationId}.vrt`);
            const listPath = path.join(outDir, 'source-filelist.txt');
            fs.writeFileSync(listPath, rasterFiles.map(file => path.join(sourceRoot, file)).join('\n') + '\n');
            await runGdalCommand(GDAL_BUILDVRT_CMD, ['-input_file_list', listPath, sourcePath], outDir);
            fs.rmSync(listPath, { force: true });
            sourceManaged = true;
        } else {
            if (!vrtFiles.length) throw new Error('Ingen TIFF eller VRT hittades i nedladdningsmappen.');
            sourcePath = path.join(sourceRoot, vrtFiles[0]);
        }
        const { stdout } = await runGdalCommand(GDAL_GDALINFO_CMD, ['-json', sourcePath], sourceRoot);
        const sourceInfo = JSON.parse(stdout);
        const pixelSizeMeters = Math.max(Math.abs(sourceInfo.geoTransform?.[1] || 0), Math.abs(sourceInfo.geoTransform?.[5] || 0));
        if (!Number.isFinite(pixelSizeMeters) || pixelSizeMeters <= 0) throw new Error('Kunde inte läsa upplösningen från VRT-källan.');

        const catalogInfo = {
            alias,
            title: alias.replace(/_/g, ' '),
            folderName,
            publicFolder: outDir,
            renderMode: 'ondemand',
            sourceRaster: sourcePath,
            sourceManaged,
            cacheKey: randomUUID(),
            targetCrs: 'EPSG:3857',
            hillshadeStyle,
            pixelSizeMeters,
            maxZoom: MAX_ZOOM,
            generatedAt: new Date().toISOString()
        };
        return { outDir, catalogInfo };
    } catch (error) {
        if (sourceManaged && sourcePath) fs.rmSync(sourcePath, { force: true });
        fs.rmSync(outDir, { recursive: true, force: true });
        throw error;
    }
}

function getPublicBaseUrl(req, alias) {
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    return `${protocol}://${host}/terrain/${alias}`;
}

function buildCatalogConfig(req, catalog) {
    const baseUrl = getPublicBaseUrl(req, catalog.alias);
    const resolutionMeters = catalog.resolutionMeters || DEFAULT_TERRAIN_RESOLUTION;
    return {
        catalogId: catalog.alias,
        title: catalog.title,
        alias: catalog.alias,
        folderName: catalog.folderName,
        publicUrl: baseUrl,
        resolutionMeters,
        hillshadeStyle: catalog.hillshadeStyle || { altitude: 45, strength: 1 },
        sourceCrs: catalog.sourceCrs || 'EPSG:3006',
        targetCrs: 'EPSG:3857',
        tileUrl: `${baseUrl}/tiles/{z}/{x}/{y}.png`,
        isPublic: catalog.isPublic !== false,
        renderMode: catalog.generated?.renderMode || 'pregenerated',
        nativeMaxZoom: catalog.generated?.renderMode === 'ondemand' ? null : catalog.generated && catalog.generated.maxZoom,
        maxZoom: MAX_ZOOM,
        status: catalog.status || 'ready',
        updatedAt: catalog.updatedAt || new Date().toISOString()
    };
}

async function ensureCatalogAndMetadata(req, rawFolderName, providedAlias, title, resolutionMeters, rawStyle) {
    const folderName = String(rawFolderName || '').trim();
    const folderPath = path.join(__dirname, folderName);
    if (!/^LMV_DOWNLOADS_[a-zA-Z0-9_-]+$/.test(folderName) || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        throw new Error('Ogiltig LMV-downloadmapp');
    }
    if (!fs.readdirSync(folderPath).some(file => /\.(tiff?|vrt)$/i.test(file))) throw new Error('Ingen TIFF eller VRT hittades i nedladdningsmappen.');
    if (jobUsingFolder(folderName)) {
        throw new Error('Nedladdningen pågår fortfarande. Vänta tills jobbet är klart.');
    }

    const alias = normalizeCatalogAlias(providedAlias || folderName.replace(/^LMV_DOWNLOADS_/, ''));
    const catTitle = String(title || alias.replace(/_/g, ' ')).trim() || alias;
    if (resolutionMeters !== 'original' && !ALLOWED_TERRAIN_RESOLUTIONS.has(Number(resolutionMeters))) throw new Error('Välj original eller 10, 20, 50 eller 100 meter.');
    const hillshadeStyle = { altitude: Number(rawStyle?.altitude ?? 35), strength: Number(rawStyle?.strength ?? 1.7) };
    if (!Number.isFinite(hillshadeStyle.altitude) || hillshadeStyle.altitude < 15 || hillshadeStyle.altitude > 80 ||
        !Number.isFinite(hillshadeStyle.strength) || hillshadeStyle.strength < 0.5 || hillshadeStyle.strength > 3) {
        throw new Error('Ljusvinkel måste vara 15-80° och reliefstyrka 0,5-3.');
    }
    const required = validateGdalBinarySet();
    if (!required.ok) throw new Error(required.message);

    const catalogs = loadPublishedCatalogs();
    if (activePublications.has(alias)) throw new Error('Katalogen publiceras redan.');
    activePublications.add(alias);
    try {
        const generated = await publishTerrainRasterFolder(folderName, alias, hillshadeStyle);
        const previous = catalogs[alias];
        const newKey = !previous || (previous.isPublic === false && !previous.apiKeyHash) ? newServiceKey() : null;
        const entry = {
            alias,
            title: catTitle,
            folderName,
            publicFolder: generated.outDir,
            publicUrl: getPublicBaseUrl(req, alias),
            resolutionMeters: resolutionMeters === 'original' ? 'original' : Number(resolutionMeters),
            hillshadeStyle,
            sourceCrs: 'detected by GDAL',
            targetCrs: 'EPSG:3857',
            status: 'ready',
            isPublic: previous ? previous.isPublic !== false : false,
            apiKeyHash: newKey ? newKey.hash : previous.apiKeyHash,
            updatedAt: new Date().toISOString(),
            generated: generated.catalogInfo
        };
        catalogs[alias] = entry;
        savePublishedCatalogs(catalogs);
        if (previous && previous.publicFolder !== generated.outDir) {
            try {
                const oldOutput = path.resolve(previous.publicFolder || path.join(TERRAIN_PUBLIC_ROOT, alias));
                if (!oldOutput.startsWith(TERRAIN_PUBLIC_ROOT + path.sep)) throw new Error('Ogiltig publiceringsmapp');
                fs.rmSync(oldOutput, { recursive: true, force: true });
                removeCatalogGeneratedFiles(previous);
            } catch (error) {
                writeToLog(`[TERRAIN] Kunde inte rensa tidigare publicering: ${error.message}`);
            }
        }
        return { alias, entry, config: { ...buildCatalogConfig(req, entry), ...(newKey && { apiKey: newKey.key }) } };
    } finally {
        activePublications.delete(alias);
    }
}

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
const GDAL_TRANSLATE_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdal_translate.exe' : 'gdal_translate'
);
const GDAL_WARP_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdalwarp.exe' : 'gdalwarp'
);
const GDAL_DEM_CMD = path.join(GDAL_BIN, process.platform === 'win32' ? 'gdaldem.exe' : 'gdaldem');
const MANIFEST_NAME = 'manifest.json';
const COMBINED_HOJD_FOLDER = 'LMV_DOWNLOADS_markhojd';

// Standalone GDAL exes need these to resolve CRS (SWEREF99 TM) outside the QGIS shell.
const GDAL_ENV = { ...process.env };
GDAL_ENV.GDAL_NUM_THREADS ||= 'ALL_CPUS';
GDAL_ENV.GDAL_CACHEMAX ||= '1024';
if (process.platform === 'win32') {
    GDAL_ENV.PATH = [QGIS_ROOT, GDAL_ROOT, process.env.PATH].filter(Boolean).join(path.delimiter);
}
const gdalDataDir = GDAL_ROOT ? path.join(GDAL_ROOT, 'share', 'gdal') : null;
const projDataDir = QGIS_ROOT ? path.join(QGIS_ROOT, '..', 'share', 'proj') : null;
if (gdalDataDir && fs.existsSync(gdalDataDir)) GDAL_ENV.GDAL_DATA = gdalDataDir;
if (projDataDir && fs.existsSync(projDataDir)) GDAL_ENV.PROJ_DATA = GDAL_ENV.PROJ_LIB = projDataDir;
const terrainTileRenderer = createTerrainTileRenderer({
    warpPath: GDAL_WARP_CMD,
    demPath: GDAL_DEM_CMD,
    translatePath: GDAL_TRANSLATE_CMD,
    env: GDAL_ENV,
    concurrency: Math.max(1, Number(process.env.ON_DEMAND_TILE_CONCURRENCY) || 2),
    maxQueue: Math.max(1, Number(process.env.ON_DEMAND_TILE_QUEUE) || 64),
    maxCacheBytes: Math.max(1, Number(process.env.TERRAIN_CACHE_MAX_GB) || 20) * 1024 ** 3
});

function renderTerrainTile(catalog, z, x, y) {
    const generated = catalog.generated || {};
    if (!generated.sourceRaster || !/^[a-f0-9-]{36}$/i.test(generated.cacheKey || '')) return Promise.resolve(null);
    const sourcePath = path.resolve(generated.sourceRaster);
    const downloadRoot = path.resolve(__dirname, catalog.folderName || '');
    const sourceIsAllowed = sourcePath.startsWith(TERRAIN_SOURCE_ROOT + path.sep) ||
        (catalog.folderName && /^LMV_DOWNLOADS_[a-zA-Z0-9_-]+$/.test(catalog.folderName) && sourcePath.startsWith(downloadRoot + path.sep));
    if (!sourceIsAllowed) return Promise.resolve(null);
    const effectiveMaxZoom = maxZoomForResolution(catalog.resolutionMeters, generated.pixelSizeMeters);
    const renderZoom = Math.min(z, effectiveMaxZoom);
    const factor = 2 ** (z - renderZoom);
    const renderX = Math.floor(x / factor);
    const renderY = Math.floor(y / factor);
    return terrainTileRenderer.render({
        sourcePath,
        cacheFolder: path.join(TERRAIN_CACHE_ROOT, generated.cacheKey),
        style: catalog.hillshadeStyle || { altitude: 35, strength: 1.7 },
        z: renderZoom, x: renderX, y: renderY
    }).then(tile => tile && overzoomRenderedTile(tile, renderZoom, z, x, y));
}
const gdalCheck = validateGdalBinarySet();
if (!gdalCheck.ok) {
    console.warn(gdalCheck.message);
} else {
    console.log('[GDAL] Todos los binarios necesarios fueron encontrados.');
}

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

function abortableDelay(ms, signal) {
    if (!signal) return delay(ms);
    return new Promise(resolve => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function runGdalBuildVrt(targetDir, listFileName = 'filelist.txt', outputName = 'index.vrt') {
    return new Promise((resolve, reject) => {
        const exe = GDAL_BUILDVRT_CMD;
        const args = ['-input_file_list', listFileName, outputName];
        const child = spawn(exe, args, { cwd: targetDir, windowsHide: true, env: GDAL_ENV });
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
        const child = spawn(GDAL_GDALINFO_CMD, ['-approx_stats', rasterPath], { windowsHide: true, env: GDAL_ENV });
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

// PREDICTOR=2 matches LMV's own encoding and compresses their Float32 DEM better than PREDICTOR=3.
function cogArgs(inputFile, outputFile) {
    return [
        '-of', 'COG',
        '-co', 'COMPRESS=DEFLATE',
        '-co', 'PREDICTOR=2',
        '-co', 'RESAMPLING=AVERAGE',
        '-co', 'BIGTIFF=IF_SAFER',
        '-co', 'NUM_THREADS=ALL_CPUS',
        inputFile, outputFile
    ];
}

function cogCommandString(filename) {
    return ['gdal_translate', ...cogArgs(filename, `${filename}.cog.tmp`)].join(' ');
}

function runGdalToCog(targetDir, inputFile, outputFile, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(GDAL_TRANSLATE_CMD, cogArgs(inputFile, outputFile), { cwd: targetDir, windowsHide: true, env: GDAL_ENV, signal });
        let stderr = '';
        let abortError = null;
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        // On abort, reject only after the process has exited so Windows releases the output file first.
        child.on('error', err => { if (err.name === 'AbortError') abortError = err; else reject(err); });
        child.on('close', code => {
            if (abortError) return reject(abortError);
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdal_translate exited with code ${code}`));
        });
    });
}

// LMV already delivers DEFLATE COGs with overviews; re-encoding those only makes them bigger.
function isAlreadyCog(rasterPath, signal) {
    return new Promise((resolve) => {
        const child = spawn(GDAL_GDALINFO_CMD, [rasterPath], { windowsHide: true, env: GDAL_ENV, signal });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.on('error', () => resolve(false));
        child.on('close', code => {
            resolve(code === 0 && /LAYOUT=COG/.test(stdout) && /COMPRESSION=/.test(stdout) && /Overviews:/.test(stdout));
        });
    });
}

// Manifest is reconciled with disk on load: missing files are dropped, unknown .tif files are adopted.
function loadManifest(folder, collectionId) {
    let manifest = { collectionId, tiles: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST_NAME), 'utf8'));
        if (parsed && parsed.tiles) manifest = parsed;
    } catch (err) {
        if (err.code !== 'ENOENT') writeToLog(`[${collectionId}] Kunde inte läsa ${MANIFEST_NAME} (${err.message}); bygger om från befintliga filer.`);
    }
    if (!fs.existsSync(folder)) return manifest;

    const onDisk = new Set(fs.readdirSync(folder).filter(f => /\.tiff?$/i.test(f) && !f.startsWith('merged_')));
    for (const name of Object.keys(manifest.tiles)) {
        if (!onDisk.has(name)) delete manifest.tiles[name];
    }
    for (const name of onDisk) {
        if (!manifest.tiles[name]) {
            manifest.tiles[name] = { filename: name, downloaded: true, optimized: false, command: cogCommandString(name) };
        }
    }
    for (const tile of Object.values(manifest.tiles)) delete tile.url;
    return manifest;
}

function saveManifest(folder, manifest) {
    if (!fs.existsSync(folder)) return;
    manifest.updatedAt = new Date().toISOString();
    const target = path.join(folder, MANIFEST_NAME);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(manifest, null, 1));
    fs.renameSync(`${target}.tmp`, target);
}

// Runs COG check/conversion in parallel with downloads; manifest updates stay on the single JS thread.
// Aborting the signal kills running gdal processes; the original tile is untouched until the final rename.
// Each conversion already uses ALL_CPUS threads; more parallel files mostly adds disk contention.
function createTileProcessor(folder, collectionId, manifest, signal, concurrency = Math.max(1, Number(process.env.COG_CONCURRENCY) || 2)) {
    const queue = [];
    const queued = new Set();
    const stats = { converted: 0, alreadyCog: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 };
    let active = 0;
    let stopped = false;
    let idleWaiters = [];

    const processed = () => stats.converted + stats.alreadyCog + stats.failed;

    function notifyIfIdle() {
        if (active === 0 && queue.length === 0) {
            idleWaiters.forEach(resolve => resolve());
            idleWaiters = [];
        }
    }

    async function processTile(tile) {
        const src = path.join(folder, tile.filename);
        const tmp = `${src}.cog.tmp`;
        const aborted = () => signal && signal.aborted;
        try {
            if (aborted()) return;
            const cogAlready = await isAlreadyCog(src, signal);
            if (aborted()) return;
            if (cogAlready) {
                tile.optimizedBy = 'source-cog';
                stats.alreadyCog++;
            } else {
                const sizeBefore = fs.statSync(src).size;
                await runGdalToCog(folder, tile.filename, path.basename(tmp), signal);
                fs.renameSync(tmp, src);
                stats.bytesBefore += sizeBefore;
                stats.bytesAfter += fs.statSync(src).size;
                tile.optimizedBy = 'gdal_translate';
                stats.converted++;
            }
            tile.optimized = true;
            tile.optimizedAt = new Date().toISOString();
            delete tile.error;
        } catch (err) {
            try { fs.rmSync(tmp, { force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) {}
            if (aborted() || err.name === 'AbortError') return;
            if (err.code === 'ENOENT' && err.syscall && err.syscall.startsWith('spawn')) {
                writeToLog(`[${collectionId}] gdal_translate/gdalinfo hittades inte (${GDAL_TRANSLATE_CMD}). Kontrollera QGIS/GDAL i .env. Optimering stoppad.`);
                stop();
                return;
            }
            stats.failed++;
            tile.error = err.message;
            writeToLog(`[${collectionId}] Kunde inte optimera ${tile.filename}: ${err.message}`);
        }
        if (processed() % 25 === 0) {
            saveManifest(folder, manifest);
            writeToLog(`[${collectionId}] Optimering: ${processed()} klara, ${queue.length} i kö (${stats.failed} fel).`);
        }
    }

    function pump() {
        while (!stopped && active < concurrency && queue.length > 0) {
            const tile = queue.shift();
            active++;
            processTile(tile).finally(() => {
                active--;
                pump();
                notifyIfIdle();
            });
        }
    }

    function stop() {
        stopped = true;
        queue.length = 0;
        notifyIfIdle();
    }

    return {
        add(tile) {
            if (stopped || tile.optimized || queued.has(tile.filename)) return;
            queued.add(tile.filename);
            queue.push(tile);
            pump();
        },
        stop,
        drain() {
            if (active === 0 && queue.length === 0) return Promise.resolve();
            return new Promise(resolve => idleWaiters.push(resolve));
        },
        pendingCount() {
            return Object.values(manifest.tiles).filter(t => !t.optimized).length;
        },
        progress() {
            return { processed: processed(), waiting: queue.length + active, failed: stats.failed };
        },
        summary() {
            const mb = b => (b / 1048576).toFixed(1);
            const sizeInfo = stats.converted > 0 ? ` Konverterade: ${mb(stats.bytesBefore)} MB -> ${mb(stats.bytesAfter)} MB.` : '';
            return `${stats.alreadyCog} redan optimerade från LMV (COG), ${stats.converted} konverterade till COG, ${stats.failed} fel.${sizeInfo}`;
        }
    };
}

async function buildVrtWithStyle(folder, files, vrtName, logTag) {
    if (files.length === 0) return;
    const baseName = path.basename(vrtName, '.vrt');
    const listName = `${baseName}_filelist.txt`;
    fs.writeFileSync(path.join(folder, listName), files.join('\n'));
    // Stale VRT/stats would otherwise survive a rebuild.
    for (const f of [vrtName, `${vrtName}.aux.xml`]) {
        fs.rmSync(path.join(folder, f), { force: true });
    }
    await runGdalBuildVrt(folder, listName, vrtName);
    writeToLog(`[${logTag}] VRT skapad: ${path.join(folder, vrtName)} (${files.length} raster).`);

    try {
        const stats = await runGdalInfo(path.join(folder, vrtName));
        fs.writeFileSync(path.join(folder, `${baseName}.qml`), buildDynamicQml(stats.min, stats.max, 5), 'utf8');
        writeToLog(`[${logTag}] Stil skapad: ${baseName}.qml (laddas automatiskt i QGIS).`);
    } catch (styleErr) {
        writeToLog(`[${logTag}] Kunde inte generera stil: ${styleErr.message}`);
    }
}

function refreshPublishedRasterCatalogs(folderName) {
    const indexPath = path.resolve(__dirname, folderName, 'index.vrt');
    if (!fs.existsSync(indexPath)) return;
    const catalogs = loadPublishedCatalogs();
    const refreshed = [];
    for (const catalog of Object.values(catalogs)) {
        if (catalog.folderName !== folderName) continue;
        const previousGenerated = { ...(catalog.generated || {}) };
        catalog.generated = {
            ...previousGenerated,
            renderMode: 'ondemand',
            sourceRaster: indexPath,
            sourceManaged: false,
            cacheKey: randomUUID(),
            generatedAt: new Date().toISOString()
        };
        catalog.updatedAt = new Date().toISOString();
        refreshed.push(previousGenerated);
    }
    if (!refreshed.length) return;
    savePublishedCatalogs(catalogs);
    for (const previous of refreshed) {
        try { removeCatalogGeneratedFiles({ generated: previous }); }
        catch (error) { writeToLog(`[TERRAIN] Kunde inte rensa gammal rastercache: ${error.message}`); }
    }
    writeToLog(`[TERRAIN] Publicerade XYZ-kataloger för ${folderName} kopplade till uppdaterat index.vrt.`);
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

function parseCrsName(rawCrs) {
    if (!rawCrs) return 'EPSG:4326';

    if (typeof rawCrs === 'string') {
        const cleaned = rawCrs.trim();
        if (!cleaned) return 'EPSG:4326';
        const normalized = cleaned
            .replace(/^urn:ogc:def:crs:epsg::/i, 'EPSG:')
            .replace(/^urn:ogc:def:crs:ogc:1.3:/i, '')
            .replace(/^crs84$/i, 'EPSG:4326')
            .replace(/^epsg:/i, 'EPSG:');

        if (/^EPSG:\d+$/i.test(normalized)) return normalized.toUpperCase();
        const match = normalized.match(/(EPSG|ESRI)[:\s]*(\d+)/i);
        if (match) return `EPSG:${match[2]}`.toUpperCase();
        return 'EPSG:4326';
    }

    if (rawCrs && rawCrs.type === 'name' && rawCrs.properties && rawCrs.properties.name) {
        return parseCrsName(rawCrs.properties.name);
    }

    if (rawCrs && rawCrs.properties && rawCrs.properties.code) {
        return parseCrsName(rawCrs.properties.code);
    }

    return 'EPSG:4326';
}

function lonLatToWebMercator(lon, lat) {
    const x = (lon * 20037508.34) / 180;
    const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
    return [x, y * 20037508.34 / 180];
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

    const phi1 = mu +
        ((3 * e1 / 2) - (27 * e1 * e1 * e1 / 32)) * Math.sin(2 * mu) +
        ((21 * e1 * e1 / 16) - (55 * e1 * e1 * e1 * e1 / 32)) * Math.sin(4 * mu) +
        ((151 * e1 * e1 * e1 / 96)) * Math.sin(6 * mu);

    const C1 = ePrime2 * Math.cos(phi1) * Math.cos(phi1);
    const T1 = Math.tan(phi1) * Math.tan(phi1);
    const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) * Math.sin(phi1));
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi1) * Math.sin(phi1), 1.5);
    const D = x1 / (N1 * k0);

    const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (
        (D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ePrime2) * Math.pow(D, 4)) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ePrime2 - 3 * C1 * C1) * Math.pow(D, 6)) / 720
    );

    const lon = (15 * Math.PI / 180) + (
        D -
        ((1 + 2 * T1 + C1) * Math.pow(D, 3)) / 6 +
        ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ePrime2 + 24 * T1 * T1) * Math.pow(D, 5)) / 120
    ) / Math.cos(phi1);

    return [lon * (180 / Math.PI), lat * (180 / Math.PI)];
}

function projectPointToWgs84([x, y], sourceCrs = 'EPSG:4326') {
    const normalized = parseCrsName(sourceCrs);

    if (normalized === 'EPSG:4326') return [x, y];
    if (normalized === 'EPSG:3857') return webMercatorToLonLat(x, y);
    if (normalized === 'EPSG:3006') return sweref99tmToWgs84(x, y);

    return [x, y];
}

function transformCoordinateTree(value, sourceCrs = 'EPSG:4326') {
    if (!Array.isArray(value)) return value;

    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
        return projectPointToWgs84([value[0], value[1]], sourceCrs);
    }

    return value.map(item => transformCoordinateTree(item, sourceCrs));
}

function geometryFromFeatureCollection(featureCollection, sourceCrs) {
    if (!featureCollection || !Array.isArray(featureCollection.features)) return null;

    const polygons = featureCollection.features
        .map(feature => normalizeGeometryPayload(feature, sourceCrs))
        .filter(Boolean)
        .flatMap(geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);

    if (!polygons.length) return null;
    return polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons };
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

function normalizeGeometryPayload(rawGeometry, inheritedCrs = 'EPSG:4326') {
    if (!rawGeometry) return null;

    if (typeof rawGeometry === 'string') {
        const trimmed = rawGeometry.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return normalizeGeometryPayload(JSON.parse(trimmed), inheritedCrs);
            } catch (e) {
                // fall through to WKT parsing
            }
        }

        const geoJson = wktPolygonToGeoJSON(rawGeometry);
        if (geoJson) {
            console.log('[normalizeGeometryPayload] WKT convertido a GeoJSON:', JSON.stringify(geoJson));
            return geoJson;
        }
        return null;
    }

    if (typeof rawGeometry === 'object') {
        const sourceCrs = parseCrsName(rawGeometry.crs || (rawGeometry.properties && rawGeometry.properties.crs) || inheritedCrs);
        if (rawGeometry.type === 'Feature') {
            if (rawGeometry.geometry) {
                return normalizeGeometryPayload(rawGeometry.geometry, sourceCrs);
            }
            return null;
        }

        if (rawGeometry.type === 'FeatureCollection') {
            return geometryFromFeatureCollection(rawGeometry, sourceCrs);
        }

        if (rawGeometry.type === 'GeometryCollection') {
            const geometries = (rawGeometry.geometries || []).map(item => normalizeGeometryPayload(item, sourceCrs)).filter(Boolean);
            if (!geometries.length) return null;
            return { type: 'GeometryCollection', geometries };
        }

        if (rawGeometry.type && rawGeometry.coordinates) {
            const transformed = { type: rawGeometry.type, coordinates: transformCoordinateTree(rawGeometry.coordinates, sourceCrs) };
            console.log('[normalizeGeometryPayload] GeoJSON recibido y normalizado:', JSON.stringify(transformed));
            return transformed;
        }

        if (rawGeometry.geometry && rawGeometry.geometry.type) {
            return normalizeGeometryPayload(rawGeometry.geometry, sourceCrs);
        }
    }

    console.warn('[normalizeGeometryPayload] Formato de geometría no reconocido:', typeof rawGeometry, rawGeometry);
    return null;
}

// --- VALIDACIÓN DE CREDENCIALES LMV ---
async function validateLmvCredentials(apiUsername, apiKey, apiToken, apiType, collectionId) {
    const STAC_BASE = getStacBase(apiType);

    // 1) Intentar obtener al menos un item de la colección para disponer de un asset a chequear
    try {
        const searchUrl = `${STAC_BASE}/search`;
        const body = { collections: [collectionId], limit: 1 };
        // Construir headers: preferir apiToken (Bearer) si se proporcionó, si no usar X-API-Key
        const headers = {};
        if (apiKey) headers['X-API-Key'] = apiKey;
        if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
        const searchRes = await axios.post(searchUrl, body, { headers, timeout: 10000 });
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
                    // Preparar headers para el GET parcial
                    const getHeaders = { 'Range': 'bytes=0-1023' };
                    if (apiKey) getHeaders['X-API-Key'] = apiKey;
                    if (apiToken) getHeaders['Authorization'] = `Bearer ${apiToken}`;
                    const getAuth = (apiUsername && apiKey && !apiToken) ? { username: apiUsername, password: apiKey } : undefined;
                    const getRes = await axios.get(assetUrl, {
                        headers: getHeaders,
                        auth: getAuth,
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
                    writeToLog(`[VALIDATION] Asset GET failed for collection=${collectionId} apiType=${apiType} status=${status}`);
                    return { ok: false, status, message: getErr.message };
                }
            }
        }
    } catch (err) {
        // Si la búsqueda falla con 401/403 interpretarlo como credenciales inválidas
        const status = err.response ? err.response.status : null;
        writeToLog(`[VALIDATION] Search failed for collection=${collectionId} apiType=${apiType} status=${status}`);
        if (status === 401 || status === 403) return { ok: false, status };
        // En otros errores, continuar con comprobación por collections como fallback
    }

    // Fallback: intentar acceder al endpoint de collections (si no había items)
    try {
        const testUrl = `${STAC_BASE}/collections`;
        const colHeaders = {};
        if (apiKey) colHeaders['X-API-Key'] = apiKey;
        if (apiToken) colHeaders['Authorization'] = `Bearer ${apiToken}`;
        const colAuth = (apiUsername && apiKey && !apiToken) ? { username: apiUsername, password: apiKey } : undefined;
        const res = await axios.get(testUrl, {
            headers: colHeaders,
            auth: colAuth,
            timeout: 10000
        });
        return { ok: true, status: res.status };
    } catch (err) {
        const status = err.response ? err.response.status : null;
        writeToLog(`[VALIDATION] Collections check failed for apiType=${apiType} status=${status}`);
        return { ok: false, status };
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
app.post('/create-download', downloadLimiter, async (req, res) => {
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
        const authHeader = req.headers['authorization'];
        if (!apiKey && !authHeader) {
            return res.status(401).json({ success: false, error: 'API Key requerida en el header X-API-Key o Authorization: Bearer <token>' });
        }

        const headers = {};
        if (apiKey) headers['X-API-Key'] = apiKey;
        if (authHeader) headers['Authorization'] = authHeader;

        const response = await axios.get('https://api.lantmateriet.se/stac-hojd/v1/collections', {
            headers
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

async function fetchDownloadAndUnzipAll(apiKey, apiUsername, apiToken, collectionId, apiType, geometry, geometryLabel = null, abortSignal = null, job = null) {
    const STAC_BASE = getStacBase(apiType);
    const slugFromLabel = geometryLabel ? slugify(geometryLabel) : '';
    const areaSlug = slugFromLabel || (geometryLabel ? 'omrade' : '');
    const folderSuffix = areaSlug ? `_${areaSlug}` : '';
    const isRasterStore = apiType === 'hojd';
    // Höjd tiles are shared per collection so overlapping/adjacent areas never download a tile twice.
    const downloadFolderName = isRasterStore
        ? `LMV_DOWNLOADS_${collectionId}`
        : `LMV_DOWNLOADS_${collectionId}${folderSuffix}`;
    const manifest = isRasterStore ? loadManifest(downloadFolderName, collectionId) : null;
    if (manifest && Object.keys(manifest.tiles).length > 0) {
        writeToLog(`[${collectionId}] ${Object.keys(manifest.tiles).length} raster finns redan i ${downloadFolderName} och laddas inte ner igen.`);
    }
    const areaTiles = [];
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
    if (job) Object.assign(job.progress, { phase: 'search', collection: collectionId, found: 0, done: 0, total: 0, downloaded: 0, existing: 0 });

        let nextLinkInfo = null;

    // 1. PAGINACIÓN
    while (nextUrl) {
        if (abortSignal && abortSignal.aborted) {
            writeToLog(`[${collectionId}] Nedladdning avbröts av användaren.`);
            return areaTiles;
        }
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['X-API-Key'] = apiKey;
            if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
            const config = { headers, signal: abortSignal || undefined };
            let response;
            
            if (nextLinkInfo) {
                if (nextLinkInfo.method === 'POST') {
                    const mergedBody = { ...searchRequestBody, ...(nextLinkInfo.body || {}) };
                    response = await axios.post(nextUrl, mergedBody, config);
                } else {
                    // Try to do a POST if the URL is a search endpoint, because LMV STAC 
                    // sometimes drops geometry if we use GET for pagination.
                    if (nextUrl.includes('/search')) {
                        // Extract query params from nextUrl and put them in POST body to not lose geometry
                        const urlObj = new URL(nextUrl);
                        const paramsBody = { ...searchRequestBody };
                        urlObj.searchParams.forEach((val, key) => {
                            paramsBody[key] = val;
                        });
                        // Use base url without query for POST
                        response = await axios.post(`${urlObj.origin}${urlObj.pathname}`, paramsBody, config);
                    } else {
                        response = await axios.get(nextUrl, config);
                    }
                }
            } else if (!nextLinkInfo && nextUrl === `${STAC_BASE}/search`) {
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
            if (job) job.progress.found = downloadQueue.length;
            if (nextLink) {
                nextUrl = nextLink.href;
                nextLinkInfo = nextLink;
            } else {
                nextUrl = null;
                nextLinkInfo = null;
            }
            
            await delay(500); 

        } catch (error) {
            if (abortSignal && abortSignal.aborted) {
                writeToLog(`[${collectionId}] Sökning avbruten av användaren.`);
                return areaTiles;
            }
            const searchStatus = error.response && error.response.status;
            if (searchStatus === 401 || searchStatus === 403) {
                writeToLog(`[${collectionId}] Autentisering nekad (${searchStatus}) vid sökning. Token har troligen gått ut.`);
                const authErr = new Error(`LMV auth failed (${searchStatus})`);
                authErr.code = 'LMV_AUTH';
                throw authErr;
            }
            if (searchStatus === 429) {
                writeToLog(`[${collectionId}] Rate limit (429) vid paginering. Väntar 10s...`);
                await abortableDelay(10000, abortSignal);
                continue; 
            }
            writeToLog(`[${collectionId}] Fel vid paginering (HTTP ${searchStatus || 'okänt'}). Avbryter sökning.`);
            nextUrl = null;
        }
    }

    // Ta bort dubbletter baserat på URL
    downloadQueue = downloadQueue.filter((v,i,a)=>a.findIndex(t=>(t.url===v.url))===i);

    if (downloadQueue.length > 0) {
        const alreadyHave = downloadQueue.filter(q => fs.existsSync(path.join(downloadFolderName, path.basename(new URL(q.url).pathname)))).length;
        writeToLog(`[${collectionId}] Hittade ${downloadQueue.length} filer i området: ${alreadyHave} finns redan, ${downloadQueue.length - alreadyHave} laddas ner.`);
        if (job) {
            Object.assign(job.progress, { phase: 'download', total: downloadQueue.length, existing: alreadyHave });
            job.totalFound += downloadQueue.length;
        }
    } else {
        writeToLog(`[${collectionId}] Inga resultat för given geometri. Fortsätter med nästa samling.`);
        return areaTiles;
    }

    fs.mkdirSync(downloadFolderName, { recursive: true });
    if (job) job.folders.add(path.basename(downloadFolderName));

    const processor = manifest ? createTileProcessor(downloadFolderName, collectionId, manifest, abortSignal) : null;
    if (job) job.processor = processor;
    if (processor) {
        const leftover = processor.pendingCount();
        if (leftover > 0) writeToLog(`[${collectionId}] ${leftover} befintliga raster är inte optimerade än; bearbetas parallellt med nedladdningen.`);
        Object.values(manifest.tiles).forEach(t => processor.add(t));
    }

    // Array para guardar las features del GeoJSON final
    let tileIndexFeatures = [];

    // 2. DESCARGA
    try {
    for (let i = 0; i < downloadQueue.length; i++) {
        if (abortSignal && abortSignal.aborted) {
            writeToLog(`[${collectionId}] Descarga cancelada por el usuario.`);
            return areaTiles;
        }
        const itemData = downloadQueue[i];
        const url = itemData.url;
        const filename = path.basename(new URL(url).pathname);
        const filePath = path.join(downloadFolderName, filename);
        // Written first so an interrupted download is never mistaken for a finished file.
        const partPath = `${filePath}.part`;
        if (job) job.progress.done = i;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (!fs.existsSync(filePath)) {
                    await abortableDelay(1000, abortSignal);
                    if (abortSignal && abortSignal.aborted) throw new Error('aborted');
                    const httpAgent = new http.Agent({ keepAlive: false });
                    const downloadHeaders = {};
                    if (apiKey) downloadHeaders['X-API-Key'] = apiKey;
                    if (apiToken) downloadHeaders['Authorization'] = `Bearer ${apiToken}`;
                    const downloadAuth = (apiUsername && apiKey && !apiToken) ? { username: apiUsername, password: apiKey } : undefined;
                    const response = await axios({
                        method: 'GET', url, responseType: 'stream', httpAgent, timeout: 60000,
                        headers: downloadHeaders,
                        auth: downloadAuth,
                        signal: abortSignal || undefined
                    });
                    const writer = fs.createWriteStream(partPath);
                    response.data.pipe(writer);
                    await new Promise((resolve, reject) => {
                        // axios only cancels the request phase; the body stream must be torn down explicitly.
                        const onAbort = () => {
                            response.data.destroy();
                            writer.destroy();
                            reject(new Error('aborted'));
                        };
                        const cleanup = () => { if (abortSignal) abortSignal.removeEventListener('abort', onAbort); };
                        writer.on('finish', () => { cleanup(); resolve(); });
                        writer.on('error', err => { cleanup(); reject(err); });
                        response.data.on('error', err => { cleanup(); reject(err); });
                        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
                    });
                    fs.renameSync(partPath, filePath);
                    if (job) job.progress.downloaded++;
                    console.log(`[${i+1}/${downloadQueue.length}] Nedladdad: ${filename}`);
                } else {
                    console.log(`[${i+1}/${downloadQueue.length}] Finns redan: ${filename}`);
                }

                if (manifest && /\.tiff?$/i.test(filename)) {
                    const tile = manifest.tiles[filename] || (manifest.tiles[filename] = { optimized: false });
                    Object.assign(tile, {
                        filename,
                        id: itemData.id,
                        bbox: itemData.bbox,
                        downloaded: true,
                        downloadedAt: tile.downloadedAt || new Date().toISOString(),
                        command: cogCommandString(filename)
                    });
                    areaTiles.push(filePath);
                    processor.add(tile);
                    if (areaTiles.length % 25 === 0) saveManifest(downloadFolderName, manifest);
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
                if (abortSignal && abortSignal.aborted) {
                    try { fs.rmSync(partPath, { force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) {}
                    writeToLog(`[${collectionId}] Nedladdning avbruten av användaren vid ${filename} (${i}/${downloadQueue.length} klara).`);
                    return areaTiles;
                }
                const status = error.response && error.response.status;
                if (status === 401 || status === 403) {
                    writeToLog(`[${collectionId}] Autentisering nekad (${status}) vid ${filename}. Token har troligen gått ut. Avbryter; ${i}/${downloadQueue.length} filer klara. Starta om med nytt token för att fortsätta (befintliga filer hoppas över).`);
                    const authErr = new Error(`LMV auth failed (${status})`);
                    authErr.code = 'LMV_AUTH';
                    throw authErr;
                }
                if (status === 429) {
                    const waitTime = 30000;
                    console.warn(`[${collectionId}] 429 Rate Limit. Esperando ${waitTime/1000}s...`);
                    await abortableDelay(waitTime, abortSignal);
                } else {
                    console.warn(`[${collectionId}] Fel vid nedladdning ${filename} (HTTP ${status || 'okänt'}). Försök ${attempt}/${maxRetries}`);
                    if (attempt === maxRetries) {
                        writeToLog(`[${collectionId}] Gav upp ${filename} efter ${maxRetries} försök (HTTP ${status || 'okänt'}).`);
                        if (job) job.progress.failed = (job.progress.failed || 0) + 1;
                    }
                    await abortableDelay(2000 * attempt, abortSignal);
                }
            }
        }
    }
    if (job) job.progress.done = downloadQueue.length;
    } finally {
        // Downloaded tiles are local, so they are still processed after an auth error; only a user abort skips the queue.
        if (processor) {
            if (abortSignal && abortSignal.aborted) processor.stop();
            if (job) job.progress.phase = 'optimize';
            writeToLog(`[${collectionId}] Nedladdningsfasen avslutad. Väntar på pågående optimering...`);
            await processor.drain();
            const remaining = processor.pendingCount();
            writeToLog(`[${collectionId}] Optimering: ${processor.summary()}${remaining ? ` ${remaining} raster återstår till nästa körning.` : ''}`);
        }
        if (manifest) saveManifest(downloadFolderName, manifest);
    }

    // Raster tile index covers every tile in the shared folder, not only this area.
    if (manifest) {
        tileIndexFeatures = Object.values(manifest.tiles)
            .filter(t => Array.isArray(t.bbox) && t.bbox.length === 4)
            .map(t => {
                const [minx, miny, maxx, maxy] = t.bbox;
                return {
                    type: 'Feature',
                    properties: { id: t.id, filename: t.filename, location: `./${t.filename}` },
                    geometry: { type: 'Polygon', coordinates: [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]] }
                };
            });
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

    // POST-PROCESAMIENTO (höjd): tiles ya optimerade arriba; VRT över alla tiles i samlingen + stil
    if (manifest && !(abortSignal && abortSignal.aborted)) {
        if (job) job.progress.phase = 'vrt';
        try {
            await buildVrtWithStyle(downloadFolderName, Object.keys(manifest.tiles).sort(), 'index.vrt', collectionId);
                    refreshPublishedRasterCatalogs(downloadFolderName);
        } catch (postErr) {
            writeToLog(`[${collectionId}] Fel vid skapande av VRT: ${postErr.message}`);
        }
    }

    writeToLog(`[${collectionId}] Processen slutförd.`);
    return areaTiles;
}

// --- JOBB-REGISTER (live status för Nedladdningar-sidan) ---
function createJob({ type, collectionId, geometry, geometryLabel }) {
    const id = `${type}_${collectionId}_${slugify(geometryLabel || '') || 'default'}_${Date.now()}`;
    const job = {
        id,
        type,
        collectionId,
        label: geometryLabel || (geometry ? 'valt område' : 'hela Sverige'),
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: null,
        resultPath: null,
        totalFound: 0,
        error: null,
        folders: new Set(),
        progress: { phase: 'start', failed: 0 },
        processor: null,
        controller: new AbortController()
    };
    jobs.set(id, job);
    return job;
}

function jobTypeName(job) {
    return job.type === 'hojd' ? 'Höjddata (Markhöjdmodell)' : `Vektordata (${job.collectionId})`;
}

function finishJob(job) {
    const what = `${jobTypeName(job)} för ${job.label}`;
    job.finishedAt = new Date().toISOString();
    job.processor = null;
    if (job.controller.signal.aborted) {
        job.status = 'cancelled';
        job.message = `Nedladdningen av ${what} stoppades. Redan nedladdade filer finns kvar och återanvänds nästa gång.`;
    } else if (job.error && job.error.code === 'LMV_AUTH') {
        job.status = 'failed';
        job.message = `Nedladdningen av ${what} avbröts: Lantmäteriet nekade inloggningen (token har troligen gått ut). Starta igen med nytt token – redan nedladdade filer hoppas över.`;
    } else if (job.error) {
        job.status = 'failed';
        job.message = `Nedladdningen av ${what} misslyckades. Kontrollera jobbstatus och försök igen.`;
    } else if (job.totalFound === 0) {
        job.status = 'done';
        job.message = `Inga data hittades för ${what}.`;
    } else {
        job.status = 'done';
        const where = job.resultPath
            ? ` Öppna ${job.resultPath} i QGIS.`
            : ` Filerna finns i ${[...job.folders].join(', ')}.`;
        const failed = job.progress.failed ? ` Obs: ${job.progress.failed} filer kunde inte laddas ner – starta igen för att komplettera.` : '';
        job.message = `${what} har laddats ner och är klar att användas.${where}${failed}`;
    }
    job.progress.phase = 'finished';
    writeToLog(`[JOBB ${job.id}] ${job.status.toUpperCase()}: ${job.message}`);
}

function serializeJob(job) {
    const opt = job.processor ? job.processor.progress() : null;
    return {
        id: job.id,
        type: job.type,
        collectionId: job.collectionId,
        label: job.label,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        message: job.message,
        resultPath: job.resultPath,
        folders: [...job.folders],
        progress: {
            ...job.progress,
            optimized: opt ? opt.processed : 0,
            optimizeWaiting: opt ? opt.waiting : 0
        }
    };
}

function jobUsingFolder(folderName) {
    for (const job of jobs.values()) {
        if ((job.status === 'running' || job.status === 'stopping') && job.folders.has(folderName)) return job;
    }
    return null;
}

// --- RUTA DE INICIO DE DESCARGA ---
app.post('/lmv/start-full-download', downloadLimiter, async (req, res) => {
    const { apiKey, apiUsername, apiToken, collectionId, apiType, geometry, geometryLabel } = req.body;

    // Standardvärde: om apiType saknas används 'vektor' (bakåtkompatibilitet)
    const type = apiType || 'vektor';

    // Accept either apiKey or apiToken when using token-based auth
    if (!(apiKey || apiToken) || !collectionId) return res.status(400).json({ success: false, error: 'Saknas data.' });

    // Validar credenciales antes de iniciar cualquier proceso en background
    try {
        const valid = await validateLmvCredentials(apiUsername, apiKey, apiToken, type, collectionId);
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
    const job = createJob({ type, collectionId, geometry, geometryLabel });
    const downloadId = job.id;
    const abortController = job.controller;

    // LÓGICA ESPECIAL: Descargar TODAS las Markhöjdmodell
        // ...existing code...
        // LÓGICA ESPECIAL: Descargar TODAS las Markhöjdmodell (o filtrar por área en todas)
        if (type === 'hojd' && collectionId === 'ALL_MARKHOJD') {
            
            let msg = 'Söker Markhöjdmodell-data... (Detta kan ta några minuter)';
            res.status(202).json({ success: true, message: msg, downloadId });
            
            (async () => {
                try {
                    const listHeaders = {};
                    if (apiKey) listHeaders['X-API-Key'] = apiKey;
                    if (apiToken) listHeaders['Authorization'] = `Bearer ${apiToken}`;
                    const listRes = await axios.get('https://api.lantmateriet.se/stac-hojd/v1/collections', {
                        headers: listHeaders,
                        signal: abortController.signal
                    });
                    const markhojdCols = listRes.data.collections.filter(col => 
                        col.id.toLowerCase().includes('markhojd') || col.title.toLowerCase().includes('markhöjd')
                    );
                    
                    writeToLog(`[ALL_MARKHOJD] Startar skanning av ${markhojdCols.length} samlingar för valt område.`);

                    // NUEVO: procesar estrictamente en serie + logs detallados
                    let processed = 0;
                    const allAreaTiles = [];
                    for (const col of markhojdCols) {
                        if (abortController.signal.aborted) {
                            writeToLog(`[ALL_MARKHOJD] Processen avbröts av användaren.`);
                            break;
                        }
                        processed++;
                        Object.assign(job.progress, { collectionIndex: processed, collectionCount: markhojdCols.length });
                        writeToLog(`[ALL_MARKHOJD] (${processed}/${markhojdCols.length}) -> ${col.id} — startar hämtning.`);
                        try {
                            const tiles = await fetchDownloadAndUnzipAll(apiKey, apiUsername, apiToken, col.id, 'hojd', geometry, geometryLabel, abortController.signal, job);
                            if (tiles) allAreaTiles.push(...tiles);
                            writeToLog(`[ALL_MARKHOJD] (${col.id}) slutförd.`);
                        } catch (err) {
                            writeToLog(`[ALL_MARKHOJD] (${col.id}) misslyckades: ${err.message}`);
                            if (err.code === 'LMV_AUTH') {
                                job.error = err;
                                writeToLog(`[ALL_MARKHOJD] Avbryter alla samlingar p.g.a. ogiltiga/utgångna uppgifter.`);
                                break;
                            }
                        }
                        await abortableDelay(2000, abortController.signal); // pausa entre colecciones
                    }

                    if (allAreaTiles.length > 0 && !abortController.signal.aborted) {
                        job.progress.phase = 'vrt';
                        fs.mkdirSync(COMBINED_HOJD_FOLDER, { recursive: true });
                        job.folders.add(COMBINED_HOJD_FOLDER);
                        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
                        const areaName = geometryLabel ? slugify(geometryLabel) : (geometry ? `omrade-${stamp}` : 'hela-sverige');
                        const relPaths = allAreaTiles.map(p => path.relative(COMBINED_HOJD_FOLDER, p).split(path.sep).join('/'));
                        await buildVrtWithStyle(COMBINED_HOJD_FOLDER, relPaths, `${areaName}.vrt`, 'ALL_MARKHOJD');
                        job.resultPath = path.join(COMBINED_HOJD_FOLDER, `${areaName}.vrt`);
                        writeToLog(`[ALL_MARKHOJD] Öppna ${job.resultPath} i QGIS för hela området.`);
                    }

                    writeToLog(`[ALL_MARKHOJD] SKANNING SLUTFÖRD! Kontrollera nedladdningsmappen.`);
                } catch (err) {
                    if (!abortController.signal.aborted) {
                        job.error = err;
                        writeToLog(`[ALL_MARKHOJD] Kritiskt fel: ${err.message}`);
                    }
                } finally {
                    finishJob(job);
                }
            })();
            return;
        }

    // Normal logik (en enda samling)
    res.status(202).json({ success: true, message: `Process startad för '${collectionId}'.`, downloadId });
    fetchDownloadAndUnzipAll(apiKey, apiUsername, apiToken, collectionId, type, geometry, geometryLabel, abortController.signal, job)
        .then(() => {
            const folder = [...job.folders][0];
            if (type === 'hojd' && folder && fs.existsSync(path.join(folder, 'index.vrt'))) {
                job.resultPath = path.join(folder, 'index.vrt');
            }
        })
        .catch(err => {
            console.error(`[${collectionId}] Bakgrundsjobb misslyckades (${err.code || 'okänt fel'}).`);
            if (!abortController.signal.aborted) job.error = err.code === 'LMV_AUTH' ? err : new Error('LMV_DOWNLOAD_FAILED');
        })
        .finally(() => finishJob(job));
});

app.get('/lmv/jobs', (req, res) => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt && now - Date.parse(job.finishedAt) > FINISHED_JOB_TTL_MS) jobs.delete(id);
    }
    const list = [...jobs.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(serializeJob);
    res.json({ success: true, jobs: list });
});

app.post('/lmv/cancel-download', (req, res) => {
    const { downloadId } = req.body;
    if (!downloadId) {
        return res.status(400).json({ success: false, error: 'downloadId krävs' });
    }
    const job = jobs.get(downloadId);
    if (job && job.status === 'running') {
        job.status = 'stopping';
        job.controller.abort();
        writeToLog(`[CANCEL] Stoppar jobb: ${downloadId} (nedladdning och pågående optimering)`);
        res.json({ success: true, message: 'Nedladdningen stoppas...' });
    } else if (job && job.status === 'stopping') {
        res.json({ success: true, message: 'Jobbet håller redan på att stoppas.' });
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
    if (jobUsingFolder(folderName)) {
        return res.status(409).json({ success: false, error: 'Mappen används av en pågående nedladdning. Vänta tills den är klar eller stoppa jobbet.' });
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

app.get('/terrain/catalogs', (req, res) => {
    try {
        const catalogs = Object.values(loadPublishedCatalogs()).map(item => ({
            alias: item.alias,
            title: item.title,
            folderName: item.folderName,
            vrtPath: item.generated?.sourceRaster || null,
            tileUrl: buildCatalogConfig(req, item).tileUrl,
            resolutionMeters: item.resolutionMeters,
            hillshadeStyle: item.hillshadeStyle || { altitude: 45, strength: 1 },
            renderMode: item.generated?.renderMode || 'pregenerated',
            isPublic: item.isPublic !== false,
            targetCrs: item.targetCrs || 'EPSG:3857',
            updatedAt: item.updatedAt
        }));
        res.json({ success: true, supportsCleanup: true, catalogs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/terrain/publish', (req, res) => {
    const { folderName, alias, title, resolutionMeters, hillshadeStyle } = req.body || {};
    if (jobUsingFolder(folderName)) return res.status(409).json({ success: false, error: 'Vänta tills nedladdningen är klar.' });
    if ([...publicationJobs.values()].some(job => job.folderName === folderName && job.status === 'running')) return res.status(409).json({ success: false, error: 'Mappen publiceras redan.' });
    const normalizedAlias = normalizeCatalogAlias(alias || String(folderName || '').replace(/^LMV_DOWNLOADS_/, ''));
    if (activePublications.has(normalizedAlias)) return res.status(409).json({ success: false, error: 'Katalogen publiceras redan.' });

    const id = randomUUID();
    const job = { id, folderName, alias: normalizedAlias, status: 'running', startedAt: new Date().toISOString() };
    publicationJobs.set(id, job);
    ensureCatalogAndMetadata(req, folderName, alias, title, resolutionMeters, hillshadeStyle)
        .then(({ config }) => {
            job.status = 'done';
            job.catalog = config;
        })
        .catch(error => {
            job.status = 'failed';
            job.error = error.message;
            writeToLog(`[TERRAIN] Publicering misslyckades: ${error.message}`);
        })
        .finally(() => { job.finishedAt = new Date().toISOString(); });
    res.status(202).json({ success: true, jobId: id });
});

app.get('/terrain/publish/status/:id', (req, res) => {
    const job = publicationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Publiceringsjobb hittades inte.' });
    res.json({ success: true, ...job });
});

app.get('/terrain/:catalog', (req, res) => {
    const catalogs = loadPublishedCatalogs();
    const catalog = catalogs[normalizeCatalogAlias(req.params.catalog)];
    if (!catalog) {
        return res.status(404).json({ success: false, error: 'Katalog hittades inte' });
    }

    const config = buildCatalogConfig(req, catalog);
    res.json({ success: true, catalog: config });
});

app.get('/terrain/:catalog/config/:kind', (req, res) => {
    const catalogs = loadPublishedCatalogs();
    const catalog = catalogs[normalizeCatalogAlias(req.params.catalog)];
    if (!catalog) {
        return res.status(404).json({ success: false, error: 'Katalog hittades inte' });
    }

    const config = buildCatalogConfig(req, catalog);
    const kind = req.params.kind && req.params.kind.toLowerCase();
    if (kind === 'hajk') {
        return res.json({
            id: catalog.alias,
            name: catalog.title,
            title: catalog.title,
            visible: true,
            opacity: 0.8,
            type: 'tile',
            source: {
                type: 'tile',
                url: catalog.isPublic === false ? `${config.tileUrl}?api_key=<API-KEY>` : config.tileUrl,
                maxZoom: config.maxZoom,
                attribution: 'LMV / MGIS-Downloader'
            }
        });
    }
    if (kind === 'origo') {
        return res.json({
            id: catalog.alias,
            title: catalog.title,
            visible: true,
            opacity: 0.8,
            source: {
                type: 'xyz',
                url: catalog.isPublic === false ? `${config.tileUrl}?api_key=<API-KEY>` : config.tileUrl,
                maxZoom: config.maxZoom
            }
        });
    }

    res.status(400).json({ success: false, error: 'Okänt format. Använd hajk eller origo.' });
});

app.get('/terrain/:catalog/tiles/:z/:x/:y.png', async (req, res, next) => {
    const catalog = loadPublishedCatalogs()[normalizeCatalogAlias(req.params.catalog)];
    if (!catalog) return res.sendStatus(404);
    if (catalog.generated?.renderMode === 'ondemand') {
        try {
            const tile = await renderTerrainTile(catalog, Number(req.params.z), Number(req.params.x), Number(req.params.y));
            if (!tile) return res.sendStatus(404);
            res.setHeader('Cache-Control', catalog.isPublic === false ? 'private, max-age=60' : 'public, max-age=60');
            return res.type('png').send(tile);
        } catch (error) {
            if (error.code === 'TILE_QUEUE_FULL') {
                res.setHeader('Retry-After', '5');
                return res.status(503).json({ error: 'Tile-renderingskön är full. Försök igen strax.' });
            }
            writeToLog(`[TERRAIN] On-demand tile-fel (${catalog.alias}): ${error.message}`);
            return res.sendStatus(500);
        }
    }
    const nativeZoom = catalog.generated && Number(catalog.generated.maxZoom);
    const zoom = Number(req.params.z);
    if (!Number.isSafeInteger(nativeZoom) || zoom <= nativeZoom) return next();
    try {
        const tile = await overzoomTile(catalog.publicFolder, nativeZoom, zoom, Number(req.params.x), Number(req.params.y));
        if (!tile) return res.sendStatus(404);
        res.setHeader('Cache-Control', catalog.isPublic === false ? 'private, max-age=3600' : 'public, max-age=3600');
        res.type('png').send(tile);
    } catch (error) {
        writeToLog(`[TERRAIN] Tile-fel: ${error.message}`);
        res.sendStatus(500);
    }
});

app.get('/terrain/:catalog/*path', (req, res, next) => {
    const catalogs = loadPublishedCatalogs();
    const alias = normalizeCatalogAlias(req.params.catalog);
    const catalog = catalogs[alias];
    if (!catalog) {
        return next();
    }

    const folderPath = catalog.publicFolder ? catalog.publicFolder : path.join(__dirname, catalog.folderName || 'terrain');
    const raw = req.params.path || [];
    if (!raw.length) {
        return res.status(404).json({ success: false, error: 'Fil eller resurs saknas' });
    }

    try {
        const relative = (Array.isArray(raw) ? raw : raw.split(/[\\/]+/)).filter(Boolean).join(path.sep);
        const fullPath = safeJoinWithinBase(folderPath, relative);
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, error: 'Resurs hittades inte i katalogen' });
        }
        res.sendFile(fullPath);
    } catch (error) {
        res.status(403).json({ success: false, error: 'Otillåten access till katalogfil' });
    }
});

app.delete('/terrain/:catalog', (req, res) => {
    const alias = normalizeCatalogAlias(req.params.catalog);
    const catalogs = loadPublishedCatalogs();
    if (!catalogs[alias]) {
        return res.status(404).json({ success: false, error: 'Katalog hittades inte' });
    }
    if (activePublications.has(alias)) return res.status(409).json({ success: false, error: 'Publicering pågår.' });
    try {
        removePublishedCatalogs(catalogs, [alias]);
        res.json({ success: true, message: 'Katalog och publicerade filer togs bort' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/lmv/downloads/delete/:folderName', (req, res) => {
    if (req.authUser.role !== 'admin') return res.status(403).json({ success: false, error: 'Endast administratörer får ta bort nedladdningar.' });
    const folderName = req.params.folderName;
    if (!/^LMV_DOWNLOADS_[a-zA-Z0-9_-]+$/.test(folderName)) {
        return res.status(400).json({ success: false, error: 'Ogiltigt mappnamn' });
    }
    
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ success: false, error: 'Mapp hittades inte' });
    }
    if (jobUsingFolder(folderName)) {
        return res.status(409).json({ success: false, error: 'Mappen används av en pågående nedladdning. Stoppa jobbet först.' });
    }
    if ([...publicationJobs.values()].some(job => job.folderName === folderName && job.status === 'running')) {
        return res.status(409).json({ success: false, error: 'Mappen publiceras. Vänta tills publiceringen är klar.' });
    }
    
    try {
        const catalogs = loadPublishedCatalogs();
        const aliases = Object.keys(catalogs).filter(alias => catalogs[alias].folderName === folderName);
        if (aliases.length) removePublishedCatalogs(catalogs, aliases);
        fs.rmSync(folderPath, { recursive: true, force: true });
        writeToLog(`[DELETE] Mapp raderad: ${folderName}`);
        res.json({ success: true, message: 'Mappen raderades' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Servern körs på http://localhost:${port}`);
    console.log(`- Vektor:    http://localhost:${port}/lmv.html`);
    console.log(`- Höjd:      http://localhost:${port}/lmv_hojd.html`);
    console.log(`- Nedladdningar: http://localhost:${port}/downloads.html`);
});
// Endpoint para validar LMV-uppgifter rápidamente desde el cliente
app.post('/lmv/validate', async (req, res) => {
    const { apiKey, apiUsername, apiToken, collectionId, apiType } = req.body;
    const type = apiType || 'vektor';
    // Accept either apiKey or apiToken
    if (!(apiKey || apiToken) || !collectionId) return res.status(400).json({ success: false, error: 'Saknas data.' });

    try {
        const valid = await validateLmvCredentials(apiUsername, apiKey, apiToken, type, collectionId);
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

app.patch('/terrain/:catalog/access', (req, res) => {
    const alias = normalizeCatalogAlias(req.params.catalog);
    const catalogs = loadPublishedCatalogs();
    const catalog = catalogs[alias];
    if (!catalog) return res.status(404).json({ error: 'Catalog not found' });
    if (activePublications.has(alias)) return res.status(409).json({ error: 'Publication in progress' });
    const { isPublic, rotateKey } = req.body || {};
    if (typeof isPublic !== 'boolean' || (rotateKey !== undefined && typeof rotateKey !== 'boolean')) return res.status(400).json({ error: 'Invalid access settings' });
    const changedToPrivate = catalog.isPublic !== false && !isPublic;
    const generated = !isPublic && (changedToPrivate || rotateKey || !catalog.apiKeyHash) ? newServiceKey() : null;
    catalog.isPublic = isPublic;
    if (generated) catalog.apiKeyHash = generated.hash;
    catalog.updatedAt = new Date().toISOString();
    savePublishedCatalogs(catalogs);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, isPublic, ...(generated && { apiKey: generated.key }) });
});