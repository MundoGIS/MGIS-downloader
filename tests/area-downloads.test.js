const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const express = require('express');
const archiver = require('archiver');
const unzipper = require('unzipper');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('each height download creates a separate area VRT referencing only its selected shared TIFFs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-areas-'));
    let metadata = {};
    const context = {
        fs, path, randomUUID, Date, __dirname: root,
        slugify: value => value.toLowerCase(),
        loadDownloadMeta: () => metadata,
        saveDownloadMeta: value => { metadata = value; },
        buildVrtWithStyle: async (folder, references) => fs.writeFileSync(path.join(folder, 'index.vrt'), references.join('\n'))
    };
    const start = source.indexOf('async function createDownloadedArea(');
    vm.runInNewContext(source.slice(start, source.indexOf('\nfunction jobUsingFolder', start)), context);
    const job = () => ({ label: 'Område', collectionId: 'dtm-cog', folders: new Set(), progress: {} });
    try {
        const first = job();
        const second = job();
        await context.createDownloadedArea(first, ['LMV_DOWNLOADS_dtm-cog/a.tif']);
        await context.createDownloadedArea(second, ['LMV_DOWNLOADS_dtm-cog/b.tif']);
        assert.notEqual(first.resultPath, second.resultPath);
        assert.match(fs.readFileSync(path.join(root, first.resultPath), 'utf8'), /a\.tif/);
        assert.doesNotMatch(fs.readFileSync(path.join(root, first.resultPath), 'utf8'), /b\.tif/);
        assert.match(fs.readFileSync(path.join(root, second.resultPath), 'utf8'), /b\.tif/);
        assert.equal(Object.keys(metadata).length, 2);
        assert.equal(fs.readdirSync(path.dirname(path.join(root, first.resultPath))).length, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('selected raster ZIP includes only manifest-approved files and blocks busy folders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-tile-zip-'));
    fs.writeFileSync(path.join(root, 'a.tif'), 'selected-raster');
    fs.writeFileSync(path.join(root, 'b.tif'), 'unselected-raster');
    let busy = false;
    const app = express();
    app.use(express.json());
    const start = source.indexOf("app.post('/lmv/downloads/:folderName/tiles/download'");
    vm.runInNewContext(source.slice(start, source.indexOf("app.post('/lmv/downloads/:folderName/tiles/delete'", start)), {
        app, path, archiver,
        downloadFolderPath: () => root,
        jobUsingFolder: () => busy,
        rasterMaintenance: new Set(),
        loadManifest: () => ({ tiles: { 'a.tif': {}, 'b.tif': {} } })
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/lmv/downloads/LMV_DOWNLOADS_test/tiles/download`;
    const request = filenames => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filenames }) });
    try {
        assert.equal((await request(['../a.tif'])).status, 400);
        assert.equal((await request(['missing.tif'])).status, 400);
        const response = await request(['a.tif']);
        assert.equal(response.status, 200);
        const zip = await unzipper.Open.buffer(Buffer.from(await response.arrayBuffer()));
        assert.deepEqual(zip.files.map(file => file.path), ['a.tif']);
        assert.equal((await zip.files[0].buffer()).toString(), 'selected-raster');
        busy = true;
        assert.equal((await request(['a.tif'])).status, 409);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});