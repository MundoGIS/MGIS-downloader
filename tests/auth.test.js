const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

test('login, admin-only management and session invalidation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-users-'));
    process.env.USERS_FILE = path.join(directory, 'users.json');
    const { installAuth, createInitialAdmin } = require('../auth');
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    const privateKey = 'a'.repeat(64);
    const crypto = require('node:crypto');
    installAuth(app, { getCatalog: alias => ({ example: { isPublic: true }, private: { isPublic: false, apiKeyHash: crypto.createHash('sha256').update(privateKey).digest('hex') } })[alias] });
    app.get('/private', (req, res) => res.json({ ok: true }));
    app.get('/terrain/example/tiles/10/12/345.png', (req, res) => res.send('tile'));
    app.get('/terrain/private/tiles/10/12/345.png', (req, res) => res.send('private tile'));
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, options = {}) => fetch(base + url, { ...options, headers: { origin: base, ...options.headers } });
    const jsonRequest = (url, body, cookie, method = 'POST') => request(url, {
        method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(body)
    });

    try {
        assert.equal((await request('/private')).status, 401);
        assert.equal((await request('/css/style.css')).status, 200);
        assert.equal((await request('/admin/users')).status, 401);
        assert.deepEqual(await (await request('/auth/setup-status')).json(), { adminConfigured: false });
        const browserNavigation = await request('/downloads.html', { headers: { accept: 'text/html' }, redirect: 'manual' });
        assert.equal(browserNavigation.status, 302);
        assert.equal(browserNavigation.headers.get('location'), '/login.html?next=%2Fdownloads.html');
        assert.equal((await request('/terrain/example/tiles/10/12/345.png')).status, 200);
        assert.equal((await request('/terrain/private/tiles/10/12/345.png')).status, 401);
        assert.equal((await request('/terrain/private/tiles/10/12/345.png?api_key=wrong')).status, 401);
        assert.equal((await request(`/terrain/private/tiles/10/12/345.png?api_key=${privateKey}`)).status, 200);
        assert.equal((await request('/terrain/private/tiles/10/12/345.png', { headers: { 'x-api-key': privateKey } })).status, 200);
        assert.equal((await request('/terrain/example/catalog.json')).status, 401);
        assert.throws(() => createInitialAdmin('initialAdmin', '12345'), /at least 6/);
        createInitialAdmin('initialAdmin', 'example-test-password-123');
        assert.deepEqual(await (await request('/auth/setup-status')).json(), { adminConfigured: true });
        assert.match(JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'))[0].hash, /^\$2/);
        assert.throws(() => createInitialAdmin('anotherAdmin', 'example-test-password-123'), /already exist/);

        const adminLogin = await jsonRequest('/auth/login', { username: 'initialAdmin', password: 'example-test-password-123' });
        assert.equal(adminLogin.status, 200);
        const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
        assert.match(adminLogin.headers.get('set-cookie'), /HttpOnly.*SameSite=Strict/);
        assert.doesNotMatch(adminLogin.headers.get('set-cookie'), /Max-Age=/);
        const rememberedLogin = await jsonRequest('/auth/login', { username: 'initialAdmin', password: 'example-test-password-123', remember: true });
        assert.equal(rememberedLogin.status, 200);
        assert.match(rememberedLogin.headers.get('set-cookie'), /Max-Age=2592000/);
        const rememberedCookie = rememberedLogin.headers.get('set-cookie').split(';')[0];
        const rememberedFile = JSON.parse(fs.readFileSync(path.join(directory, 'remembered_sessions.json'), 'utf8'));
        assert.equal(Object.keys(rememberedFile).length, 1);
        assert.ok(!fs.readFileSync(path.join(directory, 'remembered_sessions.json'), 'utf8').includes(rememberedCookie.split('=')[1]));
        assert.equal((await request('/private', { headers: { cookie: rememberedCookie } })).status, 200);
        delete require.cache[require.resolve('../auth')];
        const { installAuth: restartedAuth } = require('../auth');
        const restartedApp = express();
        restartedApp.use(express.json());
        restartedAuth(restartedApp);
        restartedApp.get('/private', (req, res) => res.json({ ok: true }));
        const restartedServer = await new Promise(resolve => {
            const instance = restartedApp.listen(0, '127.0.0.1', () => resolve(instance));
        });
        try {
            const restartedBase = `http://127.0.0.1:${restartedServer.address().port}`;
            assert.equal((await fetch(restartedBase + '/private', { headers: { cookie: rememberedCookie } })).status, 200);
            assert.equal((await fetch(restartedBase + '/private', { headers: { cookie: adminCookie } })).status, 401);
        } finally {
            await new Promise(resolve => restartedServer.close(resolve));
        }
        const secureLogin = await fetch(base + '/auth/login', {
            method: 'POST',
            headers: {
                origin: 'https://mgis.example',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'mgis.example',
                'content-type': 'application/json'
            },
            body: JSON.stringify({ username: 'initialAdmin', password: 'example-test-password-123' })
        });
        assert.equal(secureLogin.status, 200);
        assert.match(secureLogin.headers.get('set-cookie'), /; Secure(?:;|$)/);
        const adminUsers = await request('/admin/users', { headers: { cookie: adminCookie } });
        assert.equal(adminUsers.status, 200);
        assert.equal((await adminUsers.json()).users[0].hash, undefined);
        assert.equal((await jsonRequest('/admin/users', { username: 'tooShort', password: '12345', role: 'user' }, adminCookie)).status, 400);
        assert.equal((await jsonRequest('/admin/users', { username: 'sixChars', password: '123456', role: 'user' }, adminCookie)).status, 201);

        const created = await jsonRequest('/admin/users', { username: 'normalUser', password: 'example-user-password-123', role: 'user' }, adminCookie);
        assert.equal(created.status, 201);
        const userId = (await created.json()).user.id;
        const login = await jsonRequest('/auth/login', { username: 'normalUser', password: 'example-user-password-123' });
        const userCookie = login.headers.get('set-cookie').split(';')[0];
        assert.equal((await request('/private', { headers: { cookie: userCookie } })).status, 200);
        assert.equal((await request('/admin/users', { headers: { cookie: userCookie } })).status, 403);
        assert.equal((await request('/admin.html', { headers: { cookie: userCookie } })).status, 403);
        const adminPage = await request('/admin.html', { headers: { cookie: adminCookie } });
        assert.equal(adminPage.status, 200);
        assert.match(await adminPage.text(), /Byt namn/);
        assert.equal((await jsonRequest('/admin/users', { username: 'intruder', password: 'example-user-password-123', role: 'admin' }, userCookie)).status, 403);

        const forged = await fetch(base + '/admin/users', {
            method: 'POST', headers: { origin: 'https://evil.example', cookie: adminCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'intruder', password: 'example-user-password-123', role: 'admin' })
        });
        assert.equal(forged.status, 403);
        const adminId = (await (await request('/admin/users', { headers: { cookie: adminCookie } })).json()).users[0].id;
        assert.equal((await jsonRequest(`/admin/users/${adminId}`, { role: 'user' }, adminCookie, 'PATCH')).status, 409);
        assert.equal((await jsonRequest(`/admin/users/${adminId}`, { username: 'NORMALUSER' }, adminCookie, 'PATCH')).status, 409);
        assert.equal((await jsonRequest(`/admin/users/${adminId}`, { username: 'x!' }, adminCookie, 'PATCH')).status, 400);
        const rename = await jsonRequest(`/admin/users/${adminId}`, { username: 'renamedAdmin' }, adminCookie, 'PATCH');
        assert.equal(rename.status, 200);
        assert.equal((await rename.json()).user.username, 'renamedAdmin');
        assert.equal((await (await request('/auth/me', { headers: { cookie: adminCookie } })).json()).user.username, 'renamedAdmin');
        assert.equal((await jsonRequest('/auth/login', { username: 'initialAdmin', password: 'example-test-password-123' })).status, 401);
        assert.equal((await jsonRequest('/auth/login', { username: 'renamedAdmin', password: 'example-test-password-123' })).status, 200);
        assert.equal((await jsonRequest(`/admin/users/${userId}`, { password: 'changed-user-password-123' }, adminCookie, 'PATCH')).status, 200);
        assert.equal((await request('/private', { headers: { cookie: userCookie } })).status, 401);
        assert.equal((await request('/auth/logout', { method: 'POST', headers: { cookie: adminCookie } })).status, 200);
        assert.equal((await request('/private', { headers: { cookie: adminCookie } })).status, 401);
        assert.equal((await request('/auth/logout', { method: 'POST', headers: { cookie: rememberedCookie } })).status, 200);
        assert.equal((await request('/private', { headers: { cookie: rememberedCookie } })).status, 401);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
        delete process.env.USERS_FILE;
    }
});