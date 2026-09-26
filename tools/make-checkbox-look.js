'use strict';
// Эталоны флажка для тестов C#-версии: как рисует флажки сам Electron.
//
//   npx electron tools/make-checkbox-look.js
//
// Берёт renderer/styles.css, рисует включённый флажок и «частично» на фоне окна
// в натуральную величину (1x) и увеличенными вчетверо (4x) и кладёт кадры 16x16 и
// 64x64 в csharp/tests/SyncGlass.Tests/look/. Запускать после любой правки
// флажка в styles.css - тесты WindowTests сравнивают с этими кадрами окно WPF.
//
// Окно - offscreen: у скрытого обычного окна capturePage висит или падает
// с UnknownVizError.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const out = path.join(root, 'csharp', 'tests', 'SyncGlass.Tests', 'look');
const html = `<html><head><style>${css}</style><style>body{margin:0;background:#1c2128} .w{position:absolute;left:8px;top:8px}</style></head>
<body><div class="w"><input type="checkbox" id="a" checked></div><div class="w" style="left:40px"><input type="checkbox" id="b"></div></body>
<script>document.getElementById('b').indeterminate=true</script></html>`;

setTimeout(() => app.exit(2), 30000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 120, show: false, backgroundColor: '#1c2128', webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  for (const zoom of [1, 4]) {
    win.webContents.setZoomFactor(zoom);
    await new Promise(r => setTimeout(r, 400));
    const shot = await win.webContents.capturePage();
    for (const [name, x] of [['checked', 8], ['mixed', 40]]) {
      const crop = shot.crop({ x: x * zoom, y: 8 * zoom, width: 16 * zoom, height: 16 * zoom });
      fs.writeFileSync(path.join(out, `checkbox-${name}-electron-${zoom}x.png`), crop.toPNG());
    }
  }
  app.quit();
});
