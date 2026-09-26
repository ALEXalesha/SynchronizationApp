'use strict';
// Значок Electron-версии SyncGlass. У C#-версии свой значок (csharp/tools/generate-icon.ps1) -
// так решил Алексей 26.09.2026: «у C# пусть останется его ава, а новая для Electron».
//
//   npx electron tools/make-icon.js
//
// Рисунок - tools/icon-art.js.
//
// Кладёт:
//   assets/icon.svg        - логотип в шапке окна;
//   assets/icon.png (256)  - значок окна и панели задач;
//   assets/icon.ico        - exe и установщик (package.json build.win.icon).
//
// Растр делает сам Chromium (окно offscreen): так значок и логотип в шапке совпадают.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { svg, ico, SIZES } = require('./icon-art');

const root = path.join(__dirname, '..');

setTimeout(() => app.exit(2), 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 300, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const render = async (size) => {
    const html = `<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 300));
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    return shot.resize({ width: size, height: size }).toPNG();
  };
  const pngs = [];
  for (const size of SIZES) pngs.push([size, await render(size)]);
  const icon = ico(pngs);

  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'icon.svg'), svg(256));
  fs.writeFileSync(path.join(assets, 'icon.png'), pngs[0][1]);
  fs.writeFileSync(path.join(assets, 'icon.ico'), icon);
  console.log(`icon: ${SIZES.join(', ')} px, ${icon.length} bytes`);
  app.quit();
});
