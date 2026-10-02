const { maxZoomForResolution, overzoomRenderedTile, xyzTileBounds } = require('../terrain-renderer');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const express = require('express');
const vm = require('node:vm');
const { MAX_ZOOM, overzoomTile } = require('../terrain-tiles');

test('on-demand XYZ bounds include a one-pixel edge buffer', () => {
    const bounds = xyzTileBounds(0, 0, 0);
    assert.ok(bounds);
    assert.ok(bounds.minX < -20037508.342789244);
    assert.ok(bounds.maxY > 20037508.342789244);
    assert.ok(Math.abs(bounds.pixelSize - 156543.03392804097) < 1e-8);
    assert.equal(xyzTileBounds(23, 0, 0), null);
    assert.equal(xyzTileBounds(4, 16, 0), null);
});

test('high zoom XYZ tiles crop native tiles without losing the map', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-overzoom-'));
    const tileFolder = path.join(folder, 'tiles', '10', '512');
    fs.mkdirSync(tileFolder, { recursive: true });
    const pixels = Buffer.alloc(256 * 256 * 4);
    for (let row = 0; row < 256; row++) {
        for (let column = 0; column < 256; column++) {
            const offset = (row * 256 + column) * 4;
            pixels[offset] = column < 128 ? 220 : 20;
            pixels[offset + 1] = row < 128 ? 200 : 30;
            pixels[offset + 2] = 50;
            pixels[offset + 3] = 255;
        }
    }
    try {
        await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } }).png().toFile(path.join(tileFolder, '512.png'));
        const upperLeft = await overzoomTile(folder, 10, 11, 1024, 1024);
        const lowerRight = await overzoomTile(folder, 10, 11, 1025, 1025);
        assert.deepEqual([...await sharp(upperLeft).raw().toBuffer()].slice(0, 4), [220, 200, 50, 255]);
        assert.deepEqual([...await sharp(lowerRight).raw().toBuffer()].slice(0, 4), [20, 30, 50, 255]);
        const close = await overzoomTile(folder, 10, MAX_ZOOM, 512 * 2 ** (MAX_ZOOM - 10), 512 * 2 ** (MAX_ZOOM - 10));
        assert.equal((await sharp(close).metadata()).width, 256);
        assert.equal(await overzoomTile(folder, 10, MAX_ZOOM + 1, 0, 0), null);
        assert.equal(await overzoomTile(folder, 10, 11, 10, 10), null);
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('Express serves virtual XYZ tiles through zoom 22', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-overzoom-http-'));
    const tileFolder = path.join(folder, 'tiles', '10', '512');
    fs.mkdirSync(tileFolder, { recursive: true });
    const app = express();
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf("app.get('/terrain/:catalog/tiles/:z/:x/:y.png'");
    const handler = source.slice(start, source.indexOf("app.get('/terrain/:catalog/*path'", start));
    vm.runInNewContext(handler, {
        app,
        loadPublishedCatalogs: () => ({ example: { publicFolder: folder, generated: { maxZoom: 10 }, isPublic: true } }),
        normalizeCatalogAlias: value => value,
        overzoomTile,
        writeToLog: () => {}
    });
    app.get('/terrain/example/tiles/:z/:x/:y.png', (req, res) => res.sendStatus(404));
    let server;
    try {
        await sharp({ create: { width: 256, height: 256, channels: 4, background: '#527c90' } }).png().toFile(path.join(tileFolder, '512.png'));
        server = await new Promise(resolve => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        const base = `http://127.0.0.1:${server.address().port}/terrain/example/tiles`;
        const factor = 2 ** 11;
        const response = await fetch(`${base}/21/${512 * factor}/${512 * factor}.png`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^image\/png/);
        assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, 256);
        assert.equal((await fetch(`${base}/23/0/0.png`)).status, 404);
        assert.equal((await fetch(`${base}/21/0/0.png`)).status, 404);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('Express serves on-demand XYZ through the existing catalog route', async () => {
    const app = express();
    const catalog = { alias: 'demo', generated: { renderMode: 'ondemand' }, isPublic: true };
    const calls = [];
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf("app.get('/terrain/:catalog/tiles/:z/:x/:y.png'");
    const handler = source.slice(start, source.indexOf("app.get('/terrain/:catalog/*path'", start));
    vm.runInNewContext(handler, {
        app,
        loadPublishedCatalogs: () => ({ demo: catalog }),
        normalizeCatalogAlias: value => value,
        renderTerrainTile: async (entry, z, x, y) => {
            calls.push([entry.alias, z, x, y]);
            return Buffer.from('tile-png');
        },
        writeToLog: () => {},
        MAX_ZOOM,
        overzoomTile
    });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/terrain/demo/tiles/8/42/91.png`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^image\/png/);
        assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
        assert.deepEqual(calls, [['demo', 8, 42, 91]]);
        assert.equal(await response.text(), 'tile-png');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('on-demand resolution limits detail and higher zooms crop their parent tile', async () => {
    assert.equal(maxZoomForResolution(10), 13);
    assert.equal(maxZoomForResolution(20), 12);
    assert.equal(maxZoomForResolution(50), 11);
    assert.equal(maxZoomForResolution(100), 10);
    assert.equal(maxZoomForResolution('original', 2), 16);

    const pixels = Buffer.alloc(256 * 256 * 4);
    for (let row = 0; row < 256; row++) {
        for (let column = 0; column < 256; column++) {
            const offset = (row * 256 + column) * 4;
            pixels[offset] = column < 128 ? 240 : 10;
            pixels[offset + 1] = row < 128 ? 220 : 20;
            pixels[offset + 2] = 40;
            pixels[offset + 3] = 255;
        }
    }
    const parent = await sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
    const child = await overzoomRenderedTile(parent, 10, 11, 1025, 1025);
    assert.deepEqual([...await sharp(child).raw().toBuffer()].slice(0, 4), [10, 20, 40, 255]);
});