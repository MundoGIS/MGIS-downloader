const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

test('only admins may delete download folders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-delete-'));
    const folder = path.join(root, 'LMV_DOWNLOADS_example');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'keep.tif'), 'fixture');
    const app = express();
    app.use((req, res, next) => { req.authUser = { role: req.get('x-test-role') }; next(); });
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf("app.delete('/lmv/downloads/delete/:folderName'");
    const handler = source.slice(start, source.indexOf('app.listen(', start));
    vm.runInNewContext(handler, {
        app, fs, path, __dirname: root,
        jobUsingFolder: () => null,
        publicationJobs: new Map(),
        loadPublishedCatalogs: () => ({}),
        removePublishedCatalogs: () => {},
        writeToLog: () => {}
    });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const url = `http://127.0.0.1:${server.address().port}/lmv/downloads/delete/LMV_DOWNLOADS_example`;
    try {
        const regular = await fetch(url, { method: 'DELETE', headers: { 'x-test-role': 'user' } });
        assert.equal(regular.status, 403);
        assert.equal(fs.existsSync(path.join(folder, 'keep.tif')), true);
        const admin = await fetch(url, { method: 'DELETE', headers: { 'x-test-role': 'admin' } });
        assert.equal(admin.status, 200);
        assert.equal(fs.existsSync(folder), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});