const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
const keyPath = path.resolve(process.env.CREDENTIALS_KEY_FILE || path.join(dataDir, 'credentials.key'));
const accountPath = path.resolve(process.env.LMV_ACCOUNT_FILE || path.join(dataDir, 'lmv_account.json'));
const MAX_SECRET_LENGTH = 4096;
let cachedKey = null;

function writePrivateFile(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, target);
        if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function encryptionKey() {
    if (cachedKey) return cachedKey;
    if (process.env.CREDENTIALS_SECRET) {
        cachedKey = crypto.createHash('sha256').update(process.env.CREDENTIALS_SECRET).digest();
        return cachedKey;
    }
    if (!fs.existsSync(keyPath)) writePrivateFile(keyPath, crypto.randomBytes(32).toString('hex'));
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Ogiltig nyckelfil för krypterade uppgifter.');
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
}

function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decryptSecret(blob) {
    const [version, iv, tag, data] = String(blob || '').split(':');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Ogiltigt krypterat värde.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function cleanSecret(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error('Ogiltigt värde.');
    const trimmed = value.trim();
    if (trimmed.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(trimmed)) throw new Error('Ogiltigt värde.');
    return trimmed;
}

function readLmvAccount() {
    if (!fs.existsSync(accountPath)) return null;
    const stored = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
    return {
        authType: stored.authType === 'token' ? 'token' : 'userpass',
        username: stored.username || '',
        apiKey: stored.apiKey ? decryptSecret(stored.apiKey) : '',
        apiToken: stored.apiToken ? decryptSecret(stored.apiToken) : '',
        updatedAt: stored.updatedAt || null
    };
}

function lmvAccountSummary() {
    try {
        const account = readLmvAccount();
        if (!account) return { configured: false };
        return { configured: true, authType: account.authType, username: account.authType === 'userpass' ? account.username : '', updatedAt: account.updatedAt };
    } catch (error) {
        return { configured: false, error: 'Sparat LMV-konto kunde inte läsas.' };
    }
}

// Empty secret fields keep the stored secret so admins can edit the username alone.
function saveLmvAccount(input = {}) {
    const authType = input.authType === 'token' ? 'token' : input.authType === 'userpass' ? 'userpass' : null;
    if (!authType) throw new Error('Välj autentiseringsmetod.');
    let previous = null;
    try { previous = readLmvAccount(); } catch (error) { previous = null; }
    const keepPrevious = previous && previous.authType === authType;
    const username = cleanSecret(input.username);
    const apiKey = cleanSecret(input.apiKey) || (keepPrevious ? previous.apiKey : '');
    const apiToken = cleanSecret(input.apiToken) || (keepPrevious ? previous.apiToken : '');
    if (authType === 'userpass' && (!username || username.length > 200 || !apiKey)) throw new Error('Ange användarnamn och API-nyckel.');
    if (authType === 'token' && !apiToken) throw new Error('Ange token.');
    const record = {
        authType,
        username: authType === 'userpass' ? username : '',
        apiKey: authType === 'userpass' ? encryptSecret(apiKey) : '',
        apiToken: authType === 'token' ? encryptSecret(apiToken) : '',
        updatedAt: new Date().toISOString()
    };
    writePrivateFile(accountPath, JSON.stringify(record, null, 2));
    return lmvAccountSummary();
}

function deleteLmvAccount() {
    fs.rmSync(accountPath, { force: true });
}

module.exports = { encryptSecret, decryptSecret, readLmvAccount, lmvAccountSummary, saveLmvAccount, deleteLmvAccount };
