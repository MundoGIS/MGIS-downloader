const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');

test('private XYZ API keys, public toggle and rotation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-service-'));
    process.env.USERS_FILE = path.join(directory, 'users.json');
    process.env.SESSIONS_FILE = path.join(directory, 'sessions.json');
    const { createInitialAdmin, installAuth } = require('../auth');
    createInitialAdmin('terrainAdmin', 'example-test-password-123');
    const catalogs = { demo: { alias: 'demo', isPublic: true, folderName: 'LMV_DOWNLOADS_demo' } };
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    installAuth(app, { getCatalog: alias => catalogs[alias] });
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const routeStart = source.indexOf("app.patch('/terrain/:catalog/access'");
    const route = source.slice(routeStart, source.indexOf("app.get('/terrain/:catalog',", routeStart));
    vm.runInNewContext(route, {
        app, normalizeCatalogAlias: value => value, activePublications: new Set(),
        loadPublishedCatalogs: () => catalogs,
        savePublishedCatalogs: value => { fs.writeFileSync(path.join(directory, 'catalogs.json'), JSON.stringify(value)); },
        newServiceKey: () => { const key = crypto.randomBytes(32).toString('hex'); return { key, hash: crypto.createHash('sha256').update(key).digest('hex') }; },
        Date
    });
    app.get('/terrain/demo/tiles/10/12/345.png', (req, res) => res.send('tile'));
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const request = (url, options) => fetch(base + url, options);
        const login = await request('/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'terrainAdmin', password: 'example-test-password-123' }) });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const access = async (isPublic, rotateKey = false) => {
            const response = await request('/terrain/demo/access', { method: 'PATCH', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ isPublic, rotateKey }) });
            assert.equal(response.status, 200);
            return response.json();
        };
        const tile = key => request(`/terrain/demo/tiles/10/12/345.png${key ? `?api_key=${key}` : ''}`);
        assert.equal((await tile()).status, 200);
        const first = (await access(false)).apiKey;
        assert.equal(first.length, 64);
        assert.equal((await tile()).status, 401);
        assert.equal((await request('/terrain/demo/tiles/10/12/345.png', { method: 'HEAD' })).status, 401);
        assert.equal((await tile(first)).status, 200);
        assert.equal((await request('/terrain/demo/tiles/10/12/345.png', { method: 'HEAD', headers: { 'x-api-key': first } })).status, 200);
        const stored = fs.readFileSync(path.join(directory, 'catalogs.json'), 'utf8');
        assert.ok(!stored.includes(first));
        const second = (await access(false, true)).apiKey;
        assert.notEqual(second, first);
        assert.equal((await tile(first)).status, 401);
        assert.equal((await tile(second)).status, 200);
        await access(true);
        assert.equal((await tile()).status, 200);
        const third = (await access(false)).apiKey;
        assert.notEqual(third, second);
        assert.equal((await tile(second)).status, 401);
        assert.equal((await tile(third)).status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
        delete process.env.USERS_FILE;
        delete process.env.SESSIONS_FILE;
    }
});