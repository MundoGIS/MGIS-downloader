const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const storePath = path.resolve(process.env.USERS_FILE || path.join(__dirname, 'data', 'users.json'));
const rememberedPath = path.resolve(process.env.SESSIONS_FILE || path.join(path.dirname(storePath), 'remembered_sessions.json'));
const sessions = new Map();
const attempts = new Map();
const sessionLifetime = 8 * 60 * 60 * 1000;
const rememberedLifetime = 30 * 24 * 60 * 60 * 1000;

function readRemembered() {
    if (!fs.existsSync(rememberedPath)) return {};
    const records = JSON.parse(fs.readFileSync(rememberedPath, 'utf8'));
    if (!records || Array.isArray(records) || typeof records !== 'object') throw new Error('Ogiltigt sessionsregister.');
    return records;
}

function writeRemembered(records) {
    fs.mkdirSync(path.dirname(rememberedPath), { recursive: true });
    const temporary = `${rememberedPath}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, rememberedPath);
        if (process.platform !== 'win32') fs.chmodSync(rememberedPath, 0o600);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function readUsers() {
    if (!fs.existsSync(storePath)) return [];
    const users = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!Array.isArray(users)) throw new Error('Ogiltig användarfil.');
    return users;
}

function writeUsers(users) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(users, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, storePath);
        if (process.platform !== 'win32') fs.chmodSync(storePath, 0o600);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function publicUser(user) {
    return { id: user.id, username: user.username, role: user.role };
}

function validUsername(username) {
    return typeof username === 'string' && /^[a-zA-Z0-9._-]{3,40}$/.test(username);
}

function validPassword(password) {
    return typeof password === 'string' && password.length >= 6 && Buffer.byteLength(password, 'utf8') <= 72;
}

function createInitialAdmin(username, password) {
    if (!validUsername(username) || !validPassword(password)) throw new Error('Ange ett användarnamn med 3–40 tecken och ett lösenord med minst 6 tecken (högst 72 UTF-8-byte).');
    if (readUsers().length) throw new Error('Användare finns redan. Skapa fler konton i administrationspanelen.');
    const user = { id: crypto.randomUUID(), username, role: 'admin', hash: bcrypt.hashSync(password, 12) };
    writeUsers([user]);
    return publicUser(user);
}

function installAuth(app, { getCatalog = () => null } = {}) {
    const cookieName = 'mgis_session';
    function transportAllowed(req) {
        return req.secure || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    }
    function requestOrigin(req) {
        const fromProxy = req.app.get('trust proxy fn')(req.socket.remoteAddress, 0);
        const host = fromProxy && req.get('x-forwarded-host') || req.get('host');
        return `${req.protocol}://${host.split(',')[0].trim()}`;
    }

    function validOrigin(req) {
        return req.get('origin') === requestOrigin(req);
    }

    function cookie(req, value, maxAge) {
        const secure = req.secure ? '; Secure' : '';
        return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/${maxAge === null ? '' : `; Max-Age=${maxAge}`}${secure}`;
    }

    function tokenFromRequest(req) {
        const match = (req.headers.cookie || '').match(/(?:^|;\s*)mgis_session=([a-f0-9]{64})(?:;|$)/);
        return match ? match[1] : null;
    }

    function currentUser(req) {
        const token = tokenFromRequest(req);
        const key = token && crypto.createHash('sha256').update(token).digest('hex');
        const session = token && (sessions.get(token) || readRemembered()[key]);
        if (!session) return null;
        if (session.expires <= Date.now()) {
            sessions.delete(token);
            if (session.remembered) { const records = readRemembered(); delete records[key]; writeRemembered(records); }
            return null;
        }
        const user = readUsers().find(item => item.id === session.userId);
        if (!user || user.hash !== session.hash || user.role !== session.role) {
            sessions.delete(token);
            if (session.remembered) { const records = readRemembered(); delete records[key]; writeRemembered(records); }
            return null;
        }
        return user;
    }

    function requireAdmin(req, res, next) {
        if (req.authUser.role !== 'admin') return res.status(403).json({ error: 'Administratörsbehörighet krävs.' });
        next();
    }

    app.post('/auth/login', async (req, res) => {
        if (!transportAllowed(req)) return res.status(403).json({ error: 'HTTPS krävs.' });
        if (!validOrigin(req)) return res.status(403).json({ error: 'Otillåtet ursprung för begäran.' });
        const address = req.ip;
        const record = attempts.get(address) || { count: 0, until: 0 };
        if (record.until > Date.now() && record.count >= 5) return res.status(429).json({ error: 'För många försök. Försök igen senare.' });
        const { username, password, remember } = req.body || {};
        const user = typeof username === 'string' ? readUsers().find(item => item.username.toLowerCase() === username.toLowerCase()) : null;
        const matches = await bcrypt.compare(validPassword(password) ? password : '', user ? user.hash : '$2b$12$3BgsZ71mqxC3DqRVud1Z9.O68dHd2mY91dpClL0qDJNUZjF6Db0Iu');
        if (!user || !matches) {
            attempts.set(address, { count: record.until > Date.now() ? record.count + 1 : 1, until: record.until > Date.now() ? record.until : Date.now() + 15 * 60 * 1000 });
            return res.status(401).json({ error: 'Fel användarnamn eller lösenord.' });
        }
        attempts.delete(address);
        const previous = tokenFromRequest(req);
        if (previous) {
            sessions.delete(previous);
            const records = readRemembered();
            delete records[crypto.createHash('sha256').update(previous).digest('hex')];
            writeRemembered(records);
        }
        const token = crypto.randomBytes(32).toString('hex');
        const staySignedIn = remember === true;
        const session = { userId: user.id, hash: user.hash, role: user.role, expires: Date.now() + (staySignedIn ? rememberedLifetime : sessionLifetime), remembered: staySignedIn };
        if (staySignedIn) {
            const records = readRemembered();
            records[crypto.createHash('sha256').update(token).digest('hex')] = session;
            writeRemembered(records);
        } else sessions.set(token, session);
        res.setHeader('Set-Cookie', cookie(req, token, staySignedIn ? Math.floor(rememberedLifetime / 1000) : null));
        res.json({ user: publicUser(user) });
    });

    app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
    app.get('/css/style.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'css', 'style.css')));
    app.get('/auth/setup-status', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ adminConfigured: readUsers().some(user => user.role === 'admin') });
    });

    app.use((req, res, next) => {
        if (!transportAllowed(req)) {
            return res.status(403).json({ error: 'HTTPS krävs.' });
        }
        const tile = ['GET', 'HEAD'].includes(req.method) && req.path.match(/^\/terrain\/([a-z0-9_-]+)\/tiles\/\d+\/\d+\/\d+\.png$/);
        if (tile) {
            const catalog = getCatalog(tile[1]);
            if (!catalog) return res.status(404).json({ error: 'Katalogen hittades inte.' });
            if (catalog.isPublic !== false) return next();
            const submitted = req.get('x-api-key') || req.query.api_key;
            if (typeof submitted !== 'string' || !/^[a-f0-9]{64}$/.test(submitted)) return res.status(401).json({ error: 'API-nyckel krävs.' });
            const submittedHash = crypto.createHash('sha256').update(submitted).digest();
            const expectedHash = /^[a-f0-9]{64}$/.test(catalog.apiKeyHash || '') ? Buffer.from(catalog.apiKeyHash, 'hex') : Buffer.alloc(32);
            if (!crypto.timingSafeEqual(submittedHash, expectedHash)) return res.status(401).json({ error: 'Ogiltig API-nyckel.' });
            return next();
        }
        const user = currentUser(req);
        if (!user) {
            if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html') || req.get('accept')?.includes('text/html'))) {
                return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
            }
            return res.status(401).json({ error: 'Inloggning krävs.' });
        }
        req.authUser = user;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            if (!validOrigin(req)) return res.status(403).json({ error: 'Otillåtet ursprung för begäran.' });
        }
        next();
    });

    app.get('/auth/me', (req, res) => res.json({ user: publicUser(req.authUser) }));
    app.post('/auth/logout', (req, res) => {
        const token = tokenFromRequest(req);
        sessions.delete(token);
        if (token) { const records = readRemembered(); delete records[crypto.createHash('sha256').update(token).digest('hex')]; writeRemembered(records); }
        res.setHeader('Set-Cookie', cookie(req, '', 0));
        res.json({ success: true });
    });
    app.get('/admin/users', requireAdmin, (req, res) => res.json({ users: readUsers().map(publicUser) }));
    app.post('/admin/users', requireAdmin, (req, res) => {
        const { username, password, role } = req.body || {};
        if (!validUsername(username) || !validPassword(password) || !['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Ogiltiga användaruppgifter. Lösenordet måste ha minst 6 tecken.' });
        const users = readUsers();
        if (users.some(item => item.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Användarnamnet finns redan.' });
        const user = { id: crypto.randomUUID(), username, role, hash: bcrypt.hashSync(password, 12) };
        users.push(user);
        writeUsers(users);
        res.status(201).json({ user: publicUser(user) });
    });
    app.patch('/admin/users/:id', requireAdmin, (req, res) => {
        const { username, password, role } = req.body || {};
        const users = readUsers();
        const user = users.find(item => item.id === req.params.id);
        if (!user) return res.status(404).json({ error: 'Användaren hittades inte.' });
        if (username !== undefined && !validUsername(username)) return res.status(400).json({ error: 'Användarnamnet måste ha 3–40 bokstäver, siffror, punkter, understreck eller bindestreck.' });
        if (username !== undefined && users.some(item => item.id !== user.id && item.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Användarnamnet finns redan.' });
        if (role !== undefined && !['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Ogiltig roll.' });
        if (password !== undefined && !validPassword(password)) return res.status(400).json({ error: 'Lösenordet måste ha minst 6 tecken.' });
        if (user.role === 'admin' && role === 'user' && users.filter(item => item.role === 'admin').length === 1) return res.status(409).json({ error: 'Den sista administratören kan inte ändras till användare.' });
        if (username !== undefined) user.username = username;
        if (role !== undefined) user.role = role;
        if (password !== undefined) user.hash = bcrypt.hashSync(password, 12);
        writeUsers(users);
        res.json({ user: publicUser(user) });
    });
    app.delete('/admin/users/:id', requireAdmin, (req, res) => {
        const users = readUsers();
        const user = users.find(item => item.id === req.params.id);
        if (!user) return res.status(404).json({ error: 'Användaren hittades inte.' });
        if (user.id === req.authUser.id) return res.status(409).json({ error: 'Du kan inte ta bort ditt eget konto.' });
        if (user.role === 'admin' && users.filter(item => item.role === 'admin').length === 1) return res.status(409).json({ error: 'Den sista administratören kan inte tas bort.' });
        writeUsers(users.filter(item => item.id !== user.id));
        res.json({ success: true });
    });
    app.get('/admin.html', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
}

module.exports = { installAuth, createInitialAdmin };