const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const FUNCTIONS = [
    'pathKey', 'manifestTileFeatures', 'writeTileIndexFile', 'refreshCombinedVrts', 'rotateCatalogCaches', 'removeRasterTiles',
    'refreshPublishedRasterCatalogs', 'buildVrtWithStyle', 'runGdalBuildVrt', 'runGdalInfo', 'buildDynamicQml',
    'loadManifest', 'saveManifest', 'cogCommandString', 'cogArgs', 'removePublishedCatalogs', 'removeCatalogGeneratedFiles'
];

function extractFunctions(source) {
    return FUNCTIONS.map(name => {
        const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
        assert.ok(start >= 0, `${name} not found`);
        const rest = source.slice(start + 1);
        const end = rest.search(/\n(?:async function |function |app\.|const |let )/);
        return source.slice(start, start + 1 + end);
    }).join('\n');
}

test('removing raster tiles rebuilds VRTs, combined VRTs and XYZ caches', { skip: !process.env.GDAL_TEST_BIN }, async () => {
    const bin = process.env.GDAL_TEST_BIN;
    const exe = name => path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-raster-maintenance-'));
    const folderName = 'LMV_DOWNLOADS_dtm-test';
    const folder = path.join(root, folderName);
    const combined = path.join(root, 'LMV_DOWNLOADS_markhojd');
    const publicRoot = path.join(root, 'terrain');
    const cacheRoot = path.join(root, 'terrain-cache');
    for (const directory of [folder, combined, publicRoot, cacheRoot]) fs.mkdirSync(directory, { recursive: true });
    const createRaster = (name, west) => {
        const result = spawnSync(exe('gdal_create'), ['-of', 'GTiff', '-outsize', '20', '20', '-bands', '1', '-burn', '100', '-ot', 'Float32',
            '-a_srs', 'EPSG:3006', '-a_ullr', String(west), '6880000', String(west + 1000), '6879000', path.join(folder, name)], { env: process.env });
        assert.equal(result.status, 0, String(result.stderr));
    };
    createRaster('a.tif', 490000);
    createRaster('b.tif', 491000);

    let catalogs = {};
    const context = {
        fs, path, spawn, Date, console, randomUUID, process,
        __dirname: root,
        COMBINED_HOJD_FOLDER: 'LMV_DOWNLOADS_markhojd',
        MANIFEST_NAME: 'manifest.json',
        TERRAIN_PUBLIC_ROOT: publicRoot,
        TERRAIN_SOURCE_ROOT: path.join(root, 'terrain-sources'),
        TERRAIN_CACHE_ROOT: cacheRoot,
        GDAL_BUILDVRT_CMD: exe('gdalbuildvrt'),
        GDAL_GDALINFO_CMD: exe('gdalinfo'),
        GDAL_ENV: process.env,
        loadPublishedCatalogs: () => JSON.parse(JSON.stringify(catalogs)),
        savePublishedCatalogs: value => { catalogs = JSON.parse(JSON.stringify(value)); },
        writeToLog: () => {}
    };
    vm.runInNewContext(extractFunctions(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')), context);

    try {
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ collectionId: 'dtm-test', tiles: {
            'a.tif': { filename: 'a.tif', bbox: [11, 62, 11.1, 62.1], optimized: true },
            'b.tif': { filename: 'b.tif', bbox: [11.1, 62, 11.2, 62.1], optimized: true }
        } }));
        await context.buildVrtWithStyle(folder, ['a.tif', 'b.tif'], 'index.vrt', 'test');
        await context.buildVrtWithStyle(combined, ['../LMV_DOWNLOADS_dtm-test/a.tif', '../LMV_DOWNLOADS_dtm-test/b.tif'], 'area.vrt', 'test');
        const folderCache = randomUUID();
        const combinedCache = randomUUID();
        for (const key of [folderCache, combinedCache]) fs.mkdirSync(path.join(cacheRoot, key), { recursive: true });
        catalogs = {
            dtm: { alias: 'dtm', folderName, publicFolder: path.join(publicRoot, 'dtm-1'), generated: { renderMode: 'ondemand', sourceRaster: path.join(folder, 'index.vrt'), cacheKey: folderCache } },
            area: { alias: 'area', folderName: 'LMV_DOWNLOADS_markhojd', publicFolder: path.join(publicRoot, 'area-1'), generated: { renderMode: 'ondemand', sourceRaster: path.join(combined, 'area.vrt'), cacheKey: combinedCache } }
        };

        const first = await context.removeRasterTiles(folderName, ['a.tif', '../a.tif', 'missing.tif']);
        assert.deepEqual({ ...first }, { removed: 1, remaining: 1 });
        assert.equal(fs.existsSync(path.join(folder, 'a.tif')), false);
        assert.equal(fs.existsSync(path.join(folder, 'b.tif')), true);
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')).tiles), ['b.tif']);
        assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'tile_index.geojson'), 'utf8')).features.length, 1);
        assert.doesNotMatch(fs.readFileSync(path.join(folder, 'index.vrt'), 'utf8'), /a\.tif/);
        assert.doesNotMatch(fs.readFileSync(path.join(combined, 'area.vrt'), 'utf8'), /a\.tif/);
        assert.match(fs.readFileSync(path.join(combined, 'area.vrt'), 'utf8'), /b\.tif/);
        assert.notEqual(catalogs.dtm.generated.cacheKey, folderCache);
        assert.notEqual(catalogs.area.generated.cacheKey, combinedCache);
        assert.equal(fs.existsSync(path.join(cacheRoot, folderCache)), false);
        assert.equal(fs.existsSync(path.join(cacheRoot, combinedCache)), false);

        const last = await context.removeRasterTiles(folderName, ['b.tif']);
        assert.deepEqual({ ...last }, { removed: 1, remaining: 0 });
        assert.equal(fs.existsSync(path.join(folder, 'index.vrt')), false);
        assert.equal(fs.existsSync(path.join(combined, 'area.vrt')), false);
        assert.deepEqual(Object.keys(catalogs), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
