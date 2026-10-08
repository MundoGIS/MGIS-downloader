const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-secrets-'));
process.env.CREDENTIALS_KEY_FILE = path.join(directory, 'credentials.key');
process.env.LMV_ACCOUNT_FILE = path.join(directory, 'lmv_account.json');
const { encryptSecret, decryptSecret, readLmvAccount, lmvAccountSummary, saveLmvAccount, deleteLmvAccount } = require('../secrets');

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('secrets are encrypted at rest and decrypt to the original value', () => {
    const encrypted = encryptSecret('top-secret-key');
    assert.ok(!encrypted.includes('top-secret-key'));
    assert.notEqual(encryptSecret('top-secret-key'), encrypted);
    assert.equal(decryptSecret(encrypted), 'top-secret-key');
    const parts = encrypted.split(':');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    assert.throws(() => decryptSecret(parts.join(':')));
});

test('saved LMV account can be created, edited without retyping the key, and deleted', () => {
    assert.equal(lmvAccountSummary().configured, false);
    assert.throws(() => saveLmvAccount({ authType: 'userpass', username: 'system' }));
    saveLmvAccount({ authType: 'userpass', username: 'system', apiKey: 'lmv-secret' });
    assert.ok(!fs.readFileSync(process.env.LMV_ACCOUNT_FILE, 'utf8').includes('lmv-secret'));
    saveLmvAccount({ authType: 'userpass', username: 'renamed', apiKey: '' });
    assert.deepEqual({ ...readLmvAccount(), updatedAt: null }, { authType: 'userpass', username: 'renamed', apiKey: 'lmv-secret', apiToken: '', updatedAt: null });
    const summary = lmvAccountSummary();
    assert.equal(summary.username, 'renamed');
    assert.equal(JSON.stringify(summary).includes('lmv-secret'), false);
    assert.throws(() => saveLmvAccount({ authType: 'token' }));
    saveLmvAccount({ authType: 'token', apiToken: 'bearer-value' });
    assert.equal(readLmvAccount().apiToken, 'bearer-value');
    deleteLmvAccount();
    assert.equal(readLmvAccount(), null);
});
