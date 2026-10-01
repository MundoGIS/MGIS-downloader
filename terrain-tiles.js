const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_ZOOM = 22;

async function overzoomTile(folder, nativeZoom, zoom, x, y) {
    if (![nativeZoom, zoom, x, y].every(Number.isSafeInteger) || nativeZoom < 0 || zoom <= nativeZoom || zoom > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) return null;

    const factor = 2 ** (zoom - nativeZoom);
    const tile = path.join(folder, 'tiles', String(nativeZoom), String(Math.floor(x / factor)), `${Math.floor(y / factor)}.png`);
    if (!fs.existsSync(tile)) return null;

    const tileX = x % factor;
    const tileY = y % factor;
    const left = Math.floor(tileX * 256 / factor);
    const top = Math.floor(tileY * 256 / factor);
    const right = Math.ceil((tileX + 1) * 256 / factor);
    const bottom = Math.ceil((tileY + 1) * 256 / factor);
    return sharp(tile)
        .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
        .resize(256, 256, { kernel: 'nearest' })
        .png()
        .toBuffer();
}

module.exports = { MAX_ZOOM, overzoomTile };