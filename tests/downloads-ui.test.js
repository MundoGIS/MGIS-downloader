const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'downloads.html'), 'utf8');

test('idle job polling does not replace download card controls', async () => {
    const start = source.indexOf('async function pollJobs()');
    const end = source.indexOf('async function stopJob(', start);
    let refreshes = 0;
    let jobRenders = 0;
    const context = {
        fetch: async () => ({ json: async () => ({ success: true, jobs: [] }) }),
        jobs: [], downloads: [{}], knownJobStatus: new Map(), firstJobsPoll: false,
        renderJobs: () => { jobRenders++; },
        isActive: () => false, lastFolderRefresh: 0,
        loadDownloads: async () => { refreshes++; },
        renderDownloads: () => { refreshes++; },
        setTimeout: () => {}, console, Date
    };
    await vm.runInNewContext(`${source.slice(start, end)}\npollJobs();`, context);
    assert.equal(jobRenders, 1);
    assert.equal(refreshes, 0);
});

test('download card refresh is deferred while a selector or input is focused', () => {
    const start = source.indexOf('let deferredDownloadsRender = false;');
    const end = source.indexOf('function downloadFolder(', start);
    const grid = { contains: () => true, addEventListener: () => {} };
    const context = {
        document: {
            activeElement: { matches: selector => selector.includes('select') },
            getElementById: id => {
                assert.equal(id, 'downloadsGrid', 'focused refresh must not touch other page elements');
                return grid;
            }
        },
        setTimeout: () => {}
    };
    const deferred = vm.runInNewContext(`${source.slice(start, end)}\nrenderDownloads(); deferredDownloadsRender;`, context);
    assert.equal(deferred, true);
});