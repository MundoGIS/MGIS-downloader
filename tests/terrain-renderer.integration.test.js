const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createTerrainTileRenderer } = require('../terrain-renderer');

function runGdal(executable, args, cwd, env) {
    const result = spawnSync(executable, args, { cwd, env, windowsHide: true, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout };
}

function loadPublisher(root, bin, env) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf('async function publishTerrainRasterFolder(');
    const end = source.indexOf('\nfunction getPublicBaseUrl', start);
    const publisherSource = source.slice(start, end);
    const gdal = name => path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    const context = {
        fs, path, Date, randomUUID, MAX_ZOOM: 22,
        __dirname: root,
        TERRAIN_PUBLIC_ROOT: path.join(root, 'terrain'),
        TERRAIN_SOURCE_ROOT: path.join(root, 'terrain-sources'),
        GDAL_BUILDVRT_CMD: gdal('gdalbuildvrt'),
        GDAL_GDALINFO_CMD: gdal('gdalinfo'),
        runGdalCommand: (executable, args, cwd) => runGdal(executable, args, cwd, env)
    };
    return vm.runInNewContext(`${publisherSource}\npublishTerrainRasterFolder`, context);
}

test('existing on-demand catalogs switch to the refreshed shared index VRT', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-catalog-refresh-'));
    const folderName = 'LMV_DOWNLOADS_dtm-cog';
    const folder = path.join(root, folderName);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'index.vrt'), '<VRTDataset/>');
    const previousGenerated = { renderMode: 'pregenerated', sourceRaster: path.join(root, 'terrain-sources', 'old.vrt'), sourceManaged: true, cacheKey: randomUUID() };
    const catalogs = {
        dtm: { folderName, generated: { ...previousGenerated } },
        unrelated: { folderName: 'LMV_DOWNLOADS_other', generated: { renderMode: 'ondemand' } }
    };
    const cleaned = [];
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf('function refreshPublishedRasterCatalogs(');
    const end = source.indexOf('\nfunction buildDynamicQml', start);
    const context = {
        fs, path, Date, randomUUID, __dirname: root,
        loadPublishedCatalogs: () => catalogs,
        savePublishedCatalogs: () => {},
        removeCatalogGeneratedFiles: entry => cleaned.push(entry.generated),
        writeToLog: () => {}
    };
    try {
        vm.runInNewContext(`${source.slice(start, end)}\nrefreshPublishedRasterCatalogs(folderName);`, { ...context, folderName });
        assert.equal(catalogs.dtm.generated.sourceRaster, path.join(folder, 'index.vrt'));
            assert.equal(catalogs.dtm.generated.renderMode, 'ondemand');
        assert.equal(catalogs.dtm.generated.sourceManaged, false);
        assert.notEqual(catalogs.dtm.generated.cacheKey, previousGenerated.cacheKey);
        assert.equal(catalogs.unrelated.generated.sourceRaster, undefined);
        assert.equal(cleaned.length, 1);
        assert.equal(cleaned[0].sourceRaster, previousGenerated.sourceRaster);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('GDAL renders an XYZ tile and reuses the disk cache', { skip: !process.env.GDAL_TEST_BIN }, async () => {
    const bin = process.env.GDAL_TEST_BIN;
    const executable = name => path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-renderer-'));
    const sourcePath = path.join(folder, 'source.tif');
    const create = spawnSync(executable('gdal_create'), [
        '-of', 'GTiff', '-outsize', '512', '512', '-bands', '1', '-burn', '100',
        '-a_srs', 'EPSG:3857', '-a_ullr', '-20037508', '20037508', '20037508', '-20037508', sourcePath
    ], { env: process.env, windowsHide: true });
    assert.equal(create.status, 0, create.stderr.toString());

    try {
        const renderer = createTerrainTileRenderer({
            warpPath: executable('gdalwarp'),
            demPath: executable('gdaldem'),
            translatePath: executable('gdal_translate'),
            env: process.env,
            concurrency: 1
        });
        const options = {
            sourcePath,
            cacheFolder: path.join(folder, 'cache'),
            style: { altitude: 35, strength: 1.7 },
            z: 0,
            x: 0,
            y: 0
        };
        const first = await renderer.render(options);
        const second = await renderer.render(options);
        assert.equal(first.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.deepEqual(second, first);

        const partialSourcePath = path.join(folder, 'partial-source.tif');
        const partialCreate = spawnSync(executable('gdal_create'), [
            '-of', 'GTiff', '-outsize', '512', '512', '-bands', '1', '-burn', '100',
            '-a_srs', 'EPSG:3857', '-a_ullr', '-1000000', '1000000', '1000000', '-1000000', partialSourcePath
        ], { env: process.env, windowsHide: true });
        assert.equal(partialCreate.status, 0, partialCreate.stderr.toString());
        const partialTile = await renderer.render({ ...options, sourcePath: partialSourcePath, z: 0, x: 0, y: 0 });
        const sharp = require('sharp');
        const { data, info } = await sharp(partialTile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let transparentPixels = 0;
        let opaquePixels = 0;
        for (let offset = 3; offset < data.length; offset += info.channels) {
            if (data[offset] === 0) transparentPixels++;
            if (data[offset] === 255) opaquePixels++;
        }
        assert.ok(transparentPixels > 0, 'outside-coverage pixels should be transparent');
        assert.ok(opaquePixels > 0, 'inside-coverage pixels should remain visible');
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('GDAL publication registers VRT sources and follows the refreshed collection index', { skip: !process.env.GDAL_TEST_BIN }, async () => {
    const bin = process.env.GDAL_TEST_BIN;
    const executable = name => path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgis-publish-source-'));
    const env = process.env;
    const publisher = loadPublisher(root, bin, env);
    const createRaster = filename => {
        runGdal(executable('gdal_create'), [
            '-of', 'GTiff', '-outsize', '32', '32', '-bands', '1', '-burn', '100',
            '-a_srs', 'EPSG:3857', '-a_ullr', '-1000', '1000', '1000', '-1000', filename
        ], root, env);
    };

    try {
        const outsideRaster = path.join(root, 'fixture.tif');
        createRaster(outsideRaster);
        const vrtFolder = path.join(root, 'LMV_DOWNLOADS_vrt');
        fs.mkdirSync(vrtFolder);
        const vrtPath = path.join(vrtFolder, 'index.vrt');
        runGdal(executable('gdalbuildvrt'), [vrtPath, outsideRaster], root, env);
        const vrtPublished = await publisher('LMV_DOWNLOADS_vrt', 'vrt_demo', { altitude: 35, strength: 1.7 });
        assert.equal(vrtPublished.catalogInfo.sourceRaster, vrtPath);
        assert.equal(vrtPublished.catalogInfo.sourceManaged, false);
        assert.equal(vrtPublished.catalogInfo.renderMode, 'ondemand');

        const tifFolder = path.join(root, 'LMV_DOWNLOADS_tif');
        fs.mkdirSync(tifFolder);
        const firstTile = path.join(tifFolder, 'tile-1.tif');
        const secondTile = path.join(tifFolder, 'tile-2.tif');
        createRaster(firstTile);
        const indexPath = path.join(tifFolder, 'index.vrt');
        runGdal(executable('gdalbuildvrt'), [indexPath, firstTile], root, env);
        const tifPublished = await publisher('LMV_DOWNLOADS_tif', 'tif_demo', { altitude: 35, strength: 1.7 });
        assert.equal(tifPublished.catalogInfo.sourceRaster, indexPath);
        assert.equal(tifPublished.catalogInfo.sourceManaged, false);
        assert.equal(tifPublished.catalogInfo.renderMode, 'ondemand');

        createRaster(secondTile);
        runGdal(executable('gdalbuildvrt'), ['-overwrite', indexPath, firstTile, secondTile], root, env);
        assert.equal(tifPublished.catalogInfo.sourceRaster, indexPath);
        assert.match(fs.readFileSync(indexPath, 'utf8'), /tile-2\.tif/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});