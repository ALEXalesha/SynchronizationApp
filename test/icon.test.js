'use strict';

// Значок Electron-версии. Алексей 26.09.2026: «для SyncGlass сделай иконку» - у Electron-версии
// своего значка не было, в панели задач и на ярлыке стоял атом Electron. У C#-версии значок
// остаётся свой («у C# пусть останется его ава, а новая для Electron»).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p));
const pkg = JSON.parse(read('package.json'));

// Кадры ICO: [размер, PNG].
function frames(buf) {
  assert.strictEqual(buf.readUInt16LE(2), 1, 'это не ICO');
  const out = [];
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const e = 6 + 16 * i;
    const size = buf[e] || 256;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    out.push([size, buf.subarray(off, off + len)]);
  }
  return out;
}

// PNG RGBA 8 бит без чересстрочности (так пишет Chromium) - в массив пикселей.
function pixels(png) {
  assert.ok(png.subarray(1, 4).toString() === 'PNG', 'кадр не PNG');
  let pos = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const kind = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; assert.strictEqual(data[8], 8); assert.strictEqual(data[12], 0); }
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  const at = (x, y) => {
    const i = (y * w + x) * bpp;
    return { r: px[i], g: px[i + 1], b: px[i + 2], a: bpp === 4 ? px[i + 3] : 255 };
  };
  return { w, h, at };
}

test('у Electron-версии свой значок: exe, установщик и удаление', () => {
  const icon = pkg.build.win.icon;
  assert.strictEqual(icon, 'assets/icon.ico');
  assert.ok(fs.existsSync(path.join(root, icon)), `${icon} нет`);
  assert.strictEqual(pkg.build.nsis.installerIcon, icon);
  assert.strictEqual(pkg.build.nsis.uninstallerIcon, icon);
  assert.ok(pkg.build.files.includes('assets/**/*'), 'папка assets не попадает в сборку - окно останется без значка');
});

test('окно и логотип в шапке берут значок из assets', () => {
  const main = read('main.js').toString();
  assert.match(main, /icon:\s*path\.join\(__dirname,\s*'assets',\s*'icon\.png'\)/, 'у BrowserWindow нет значка');
  assert.ok(fs.existsSync(path.join(root, 'assets', 'icon.png')));
  const html = read('renderer/index.html').toString();
  assert.match(html, /<img class="logo" src="\.\.\/assets\/icon\.svg"/, 'в шапке не значок');
});

test('в ICO все размеры для Windows, от 16 до 256', () => {
  const sizes = frames(read('assets/icon.ico')).map(([s]) => s).sort((a, b) => a - b);
  assert.deepStrictEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test('мелкие кадры не пустые и стрелки видны на фоне', () => {
  for (const [size, png] of frames(read('assets/icon.ico'))) {
    if (size > 32) continue;
    const { w, h, at } = pixels(png);
    assert.strictEqual(w, size);
    let opaque = 0, white = 0, dark = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = at(x, y);
        if (p.a < 200) continue;
        opaque++;
        const lum = 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
        if (lum > 210) white++;
        if (lum < 130) dark++;
      }
    }
    // Скруглённый квадрат занимает почти весь кадр; стрелки - заметная доля; фон - остальное.
    assert.ok(opaque >= size * size * 0.8, `${size}px: непрозрачных точек ${opaque}`);
    assert.ok(white >= size * size * 0.12, `${size}px: белых (стрелки) ${white}`);
    assert.ok(dark >= size * size * 0.3, `${size}px: тёмного фона ${dark}`);
  }
});

test('значок C#-версии остаётся своим', () => {
  const wpf = read('csharp/src/SyncGlass.Wpf/Assets/AppIcon.ico');
  assert.ok(!wpf.equals(read('assets/icon.ico')), 'C#-версии подложили значок Electron');
});
