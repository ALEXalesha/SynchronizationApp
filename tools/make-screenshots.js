'use strict';
// Кадры для README: собираются программой, а не снимком экрана.
//
//   npx electron tools/make-screenshots.js
//
// Запускается настоящее приложение (main.js) с отдельной временной папкой
// userData, чтобы не тронуть ни настройки, ни кеши, ни историю человека. В
// settings.json подкладываются две выдуманные папки во временном каталоге:
// «Ноутбук» и «Сетевой ПК». Честно: «сетевая» сторона здесь - вторая локальная
// папка, настоящей шары у скрипта нет. Для кадра это неважно - программа
// читает UNC-путь и локальный одинаково, - но выдавать её за сеть не будем.
//
// Кадр берётся с самой страницы (webContents.capturePage), поэтому в него не
// может попасть чужое окно, как бывает со снимком экрана.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncglass-shots-'));
const LOCAL = path.join(TMP, 'Ноутбук', 'Проекты');
const NETWORK = path.join(TMP, 'Сетевой ПК', 'Проекты');

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

function put(root, rel, text, daysAgo) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const t = new Date(NOW - daysAgo * DAY);
  fs.utimesSync(file, t, t);
}

// Выдуманные проекты: новое, изменённое, переложенное и лишнее на приёмнике -
// по случаю на каждую строку предпросмотра.
function makeDemo() {
  const photo = 'x'.repeat(40000);
  put(LOCAL, 'Курсовая/глава 1.docx', 'глава 1, правки научного', 1);
  put(LOCAL, 'Курсовая/глава 2.docx', 'глава 2', 0);
  put(LOCAL, 'Курсовая/литература.txt', 'список', 12);
  put(LOCAL, 'Фото/2026-08 поход/IMG_0412.jpg', photo, 30);
  put(LOCAL, 'Фото/2026-08 поход/IMG_0413.jpg', photo, 30);
  put(LOCAL, 'Фото/2026-09 дача/IMG_0501.jpg', photo, 5);
  put(LOCAL, 'Сайт/index.html', '<h1>привет</h1>', 3);
  put(LOCAL, 'Сайт/архив/старый-макет.fig', 'макет', 40);
  put(LOCAL, 'заметки.md', 'новые заметки', 0);

  put(NETWORK, 'Курсовая/глава 1.docx', 'глава 1', 8);
  put(NETWORK, 'Курсовая/литература.txt', 'список', 12);
  put(NETWORK, 'Фото/2026-08 поход/IMG_0412.jpg', photo, 30);
  put(NETWORK, 'Фото/2026-08 поход/IMG_0413.jpg', photo, 30);
  put(NETWORK, 'Сайт/index.html', '<h1>привет</h1>', 3);
  put(NETWORK, 'Сайт/старый-макет.fig', 'макет', 40);
  put(NETWORK, 'заметки.md', 'заметки', 9);
  put(NETWORK, 'черновик-удалённый.txt', 'устарело', 60);
}

makeDemo();
app.setPath('userData', path.join(TMP, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({
  localPath: LOCAL,
  networkPath: NETWORK,
  direction: 'toNetwork',
  sort: 'name',
  sizeMode: 'capped',
}));

require(path.join(ROOT, 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(win, expr, what, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(expr)) return;
    await sleep(150);
  }
  throw new Error(`не дождались: ${what}`);
}

// Код в окне возвращает строку с причиной, если что-то не нашлось: голое
// исключение из executeJavaScript говорит только «скрипт не выполнился».
async function run(win, body) {
  const why = await win.webContents.executeJavaScript(`(() => { ${body} })()`);
  if (why) throw new Error(why);
}

async function shoot(win, name) {
  await sleep(400); // стекло и анимации успевают дорисоваться
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
  console.log(`  ${name}`);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
    await until(win, "document.querySelectorAll('#localList .tree-row').length >= 4", 'дерево');
    await until(win, "!/Загрузка/.test(document.body.innerText)", 'размеры', 20000);

    // Развернуть две папки на источнике и отметить всё.
    await run(win, `
      for (const name of ['Курсовая', 'Сайт']) {
        const row = [...document.querySelectorAll('#localList .tree-row')]
          .find((r) => r.querySelector('.folder-name').textContent.trim() === name);
        if (!row) return 'нет строки ' + name + ': ' + [...document.querySelectorAll('#localList .folder-name')].map((e) => e.textContent).join(' | ');
        row.querySelector('.caret').click();
      }`);
    await sleep(700);
    await run(win, `
      // Направление «Локально → Сеть»: источник слева.
      const box = document.querySelector('.list-head[data-side="local"] .select-all');
      if (!box) return 'нет «Выбрать все» у источника';
      box.click();`);
    await until(win, "!document.getElementById('syncBtn').disabled", 'кнопка синхронизации');
    await shoot(win, 'window.png');

    await win.webContents.executeJavaScript("document.getElementById('syncBtn').click()");
    await until(win, "!document.getElementById('modal').hidden && document.getElementById('previewSummary').innerText.trim().length > 0", 'предпросмотр');
    await shoot(win, 'preview.png');
    const summary = await win.webContents.executeJavaScript("document.getElementById('previewSummary').innerText");
    console.log(`сводка в кадре: ${summary.replace(/\s+/g, ' ').trim()}`);
  } catch (err) {
    console.error(err);
    code = 1;
  } finally {
    // Папку держит сам Электрон, пока процесс жив: убираем что выйдет, остаток
    // временного каталога Windows подчистит сама.
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* занято */ }
    app.exit(code);
  }
});
