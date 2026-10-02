const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash, randomUUID } = require('crypto');

const MAX_ZOOM = 22;
const TILE_SIZE = 256;
const WEB_MERCATOR_LIMIT = 20037508.342789244;
const WEB_MERCATOR_BASE_RESOLUTION = 156543.03392804097;
const TILE_RENDER_VERSION = 'alpha-v5';

function maxZoomForResolution(resolutionMeters, sourcePixelSizeMeters = 0) {
    const requested = resolutionMeters === 'original' ? 0 : Number(resolutionMeters);
    const targetPixelSize = Math.max(Number(sourcePixelSizeMeters) || 0, requested || 0);
    if (targetPixelSize <= 0) return MAX_ZOOM;
    return Math.max(0, Math.min(MAX_ZOOM, Math.floor(Math.log2(WEB_MERCATOR_BASE_RESOLUTION / targetPixelSize))));
}

async function overzoomRenderedTile(buffer, sourceZoom, zoom, x, y) {
    if (![sourceZoom, zoom, x, y].every(Number.isSafeInteger) || sourceZoom < 0 || zoom < sourceZoom || zoom > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) return null;
    if (zoom === sourceZoom) return buffer;
    const factor = 2 ** (zoom - sourceZoom);
    const tileX = x % factor;
    const tileY = y % factor;
    const left = Math.floor(tileX * 256 / factor);
    const top = Math.floor(tileY * 256 / factor);
    const right = Math.ceil((tileX + 1) * 256 / factor);
    const bottom = Math.ceil((tileY + 1) * 256 / factor);
    const sharp = require('sharp');
    return sharp(buffer)
        .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
        .resize(256, 256, { kernel: 'nearest' })
        .png()
        .toBuffer();
}

function xyzTileBounds(z, x, y) {
    if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
    const span = WEB_MERCATOR_LIMIT * 2 / (2 ** z);
    const pixelSize = span / TILE_SIZE;
    const minX = -WEB_MERCATOR_LIMIT + x * span;
    const maxY = WEB_MERCATOR_LIMIT - y * span;
    const maxX = minX + span;
    const minY = maxY - span;
    return {
        minX: minX - pixelSize,
        minY: minY - pixelSize,
        maxX: maxX + pixelSize,
        maxY: maxY + pixelSize,
        pixelSize
    };
}

function runCommand(executable, args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, windowsHide: true, env });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `GDAL exited with code ${code}`)));
    });
}

async function listPngFiles(folder, result = []) {
    let entries;
    try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return result;
        throw error;
    }
    for (const entry of entries) {
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory() && entry.name !== '.tmp') await listPngFiles(fullPath, result);
        else if (entry.isFile() && entry.name.endsWith('.png')) {
            const stat = await fs.promises.stat(fullPath);
            result.push({ fullPath, size: stat.size, lastAccessed: stat.atimeMs });
        }
    }
    return result;
}

async function pruneCache(folder, maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    const files = await listPngFiles(folder);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= maxBytes) return;
    files.sort((left, right) => left.lastAccessed - right.lastAccessed);
    for (const file of files) {
        if (total <= maxBytes) break;
        await fs.promises.rm(file.fullPath, { force: true });
        total -= file.size;
    }
}

function createTerrainTileRenderer({ warpPath, demPath, translatePath, env, concurrency = 2, maxQueue = 64, maxCacheBytes = 20 * 1024 ** 3 }) {
    const queue = [];
    const pending = new Map();
    const lastPrune = new Map();
    let active = 0;

    async function generateTile({ sourcePath, cacheFolder, style, z, x, y }) {
        const bounds = xyzTileBounds(z, x, y);
        if (!bounds || !sourcePath || !fs.existsSync(sourcePath)) return null;
        if (!Number.isFinite(style?.altitude) || !Number.isFinite(style?.strength)) throw new Error('Ogiltig hillshade-stil.');

        const sourceStat = fs.statSync(sourcePath);
        const sourceKey = createHash('sha256')
            .update(`${path.resolve(sourcePath)}|${sourceStat.size}|${sourceStat.mtimeMs}`)
            .digest('hex')
            .slice(0, 16);
        const styleKey = `${TILE_RENDER_VERSION}-${style.altitude}-${style.strength}`;
        const tilePath = path.join(cacheFolder, sourceKey, styleKey, String(z), String(x), `${y}.png`);
        try {
            const cached = await fs.promises.readFile(tilePath);
            const now = new Date();
            await fs.promises.utimes(tilePath, now, now).catch(() => {});
            return cached;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        await fs.promises.mkdir(path.dirname(tilePath), { recursive: true });
        const tempRoot = path.join(cacheFolder, '.tmp');
        await fs.promises.mkdir(tempRoot, { recursive: true });
        const tempDir = path.join(tempRoot, randomUUID());
        await fs.promises.mkdir(tempDir);
        const warpedPath = path.join(tempDir, 'elevation.tif');
        const hillshadePath = path.join(tempDir, 'hillshade.tif');
        const alphaPath = path.join(tempDir, 'alpha.png');
        const pngPath = path.join(tempDir, 'tile.png');
        const boundsArgs = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map(value => value.toFixed(8));

        try {
            await runCommand(warpPath, [
                '-q', '-overwrite', '-multi', '-wm', '64', '-wo', 'NUM_THREADS=2',
                '-t_srs', 'EPSG:3857', '-te', ...boundsArgs, '-ts', String(TILE_SIZE + 2), String(TILE_SIZE + 2), '-dstalpha',
                '-r', 'bilinear', '-of', 'GTiff', '-co', 'COMPRESS=DEFLATE', '-co', 'NUM_THREADS=ALL_CPUS',
                sourcePath, warpedPath
            ], tempDir, env);
            await runCommand(demPath, [
                'hillshade', warpedPath, hillshadePath,
                '-alt', String(style.altitude), '-z', String(style.strength), '-compute_edges',
                '-of', 'GTiff', '-co', 'COMPRESS=DEFLATE'
            ], tempDir, env);
            await runCommand(translatePath, ['-q', '-b', '2', '-of', 'PNG', warpedPath, alphaPath], tempDir, env);
            const sharp = require('sharp');
            const crop = { left: 1, top: 1, width: TILE_SIZE, height: TILE_SIZE };
            const hillshade = await sharp(hillshadePath).extract(crop).greyscale().raw().toBuffer();
            const alpha = await sharp(alphaPath).extract(crop).greyscale().raw().toBuffer();
            const rgba = Buffer.allocUnsafe(TILE_SIZE * TILE_SIZE * 4);
            for (let pixel = 0; pixel < TILE_SIZE * TILE_SIZE; pixel++) {
                const offset = pixel * 4;
                rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = hillshade[pixel];
                rgba[offset + 3] = alpha[pixel];
            }
            await sharp(rgba, { raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 } }).png().toFile(pngPath);
            await fs.promises.rename(pngPath, tilePath);

            const nowMs = Date.now();
            const last = lastPrune.get(cacheFolder) || 0;
            if (nowMs - last > 5 * 60 * 1000) {
                lastPrune.set(cacheFolder, nowMs);
                await pruneCache(cacheFolder, maxCacheBytes);
            }
            return await fs.promises.readFile(tilePath);
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    }

    function pump() {
        while (active < concurrency && queue.length) {
            const item = queue.shift();
            active++;
            generateTile(item.options).then(item.resolve, item.reject).finally(() => {
                active--;
                pending.delete(item.key);
                pump();
            });
        }
    }

    return {
        render(options) {
            const bounds = xyzTileBounds(options.z, options.x, options.y);
            if (!bounds) return Promise.resolve(null);
            const styleKey = `${TILE_RENDER_VERSION}-${options.style?.altitude}-${options.style?.strength}`;
            const key = `${path.resolve(options.sourcePath)}|${path.resolve(options.cacheFolder)}|${styleKey}|${options.z}/${options.x}/${options.y}`;
            if (pending.has(key)) return pending.get(key);
            if (queue.length >= maxQueue) {
                const error = new Error('Tile-renderingskön är full. Försök igen strax.');
                error.code = 'TILE_QUEUE_FULL';
                return Promise.reject(error);
            }
            let resolveRequest;
            let rejectRequest;
            const promise = new Promise((resolve, reject) => {
                resolveRequest = resolve;
                rejectRequest = reject;
            });
            pending.set(key, promise);
            queue.push({ key, options, resolve: resolveRequest, reject: rejectRequest });
            pump();
            return promise;
        }
    };
}

module.exports = { MAX_ZOOM, maxZoomForResolution, overzoomRenderedTile, xyzTileBounds, createTerrainTileRenderer };