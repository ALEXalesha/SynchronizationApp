'use strict';

// История синхронизаций: пределы хранения. Два предела перемножались — 200
// запусков по 5000 файлов давали 87 МБ в history.json и миллион строк разметки
// в окне истории. Файл перечитывался и переписывался целиком после каждой
// синхронизации и целиком уезжал в renderer.

const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('node:fs').promises;
const path = require('node:path');

const { loadMain, tmpDir, writeFile } = require('./helpers/main-harness');
const { loadRenderer } = require('./helpers/renderer-harness');

const ready = loadMain();

// Запуск с поимённым списком файлов, как его пишет performSync.
const runRecord = (i, fileCount = 3) => ({
  time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  direction: 'toNetwork',
  localPath: 'C:\\local',
  networkPath: '\\\\server\\share',
  totals: { move: 0, copy: fileCount, overwrite: 0, trash: 0, dirs: 0 },
  permanentDeletes: 0,
  failures: 0,
  files: Array.from({ length: fileCount }, (_, k) => ({ action: 'copy', path: `run${i}/f${k}.txt` })),
  filesTruncated: 0,
});

test('история отдаёт поимённые списки только у последних запусков', async () => {
  const { call, userData } = await ready;
  const list = Array.from({ length: 40 }, (_, i) => runRecord(i));
  await fsp.writeFile(path.join(userData, 'history.json'), JSON.stringify(list));

  const got = await call('get-history');

  assert.strictEqual(got.length, 40, 'сами записи остаются все');
  assert.ok(got[0].files, 'у свежих запусков список файлов на месте');
  assert.ok(got[19].files, 'граница включительно');
  assert.strictEqual(got[20].files, undefined, 'у давних запусков перечня уже нет');
  assert.strictEqual(got[20].detailsDropped, true);
  assert.strictEqual(got[20].fileCount, 3, 'счётчик остаётся, чтобы было что показать');
  assert.ok(got[39].totals, 'итоги не теряются никогда');
});

test('запись новой синхронизации срезает перечни у старых, а не копит их', async () => {
  const { call, userData } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'ветка/a.txt', 'a');

  const old = Array.from({ length: 30 }, (_, i) => runRecord(i, 5));
  await fsp.writeFile(path.join(userData, 'history.json'), JSON.stringify(old));

  await call('sync', {
    localPath: local,
    networkPath: network,
    folders: ['ветка'],
    excludes: [],
    direction: 'toNetwork',
  });

  const onDisk = JSON.parse(await fsp.readFile(path.join(userData, 'history.json'), 'utf8'));
  assert.strictEqual(onDisk.length, 31);
  assert.ok(onDisk[0].files, 'свежая запись — с перечнем');
  const withFiles = onDisk.filter((r) => r.files).length;
  assert.strictEqual(withFiles, 20, 'перечни держим ровно у последних двадцати');
});

// Массив на месте, а запись внутри — мусор (обрыв записи в старых версиях,
// правка руками, порча на диске). trimHistoryDetails такую запись сторожила,
// а окно истории — нет: разметка обрывалась на полуслове и оставляла «Загрузка…»
// навсегда. Отсеиваем у самого чтения, чтобы читателям не приходилось помнить.
test('мусор внутри массива истории отсеивается на чтении', async () => {
  const { call, userData } = await ready;
  await fsp.writeFile(
    path.join(userData, 'history.json'),
    JSON.stringify([null, runRecord(0), 5, 'строка', ['массив'], runRecord(1)])
  );

  const got = await call('get-history');

  assert.strictEqual(got.length, 2, 'остаются только настоящие записи');
  assert.ok(got.every((r) => r && typeof r === 'object' && !Array.isArray(r)));
  assert.ok(got[0].totals);
});

test('окно истории не строит строки файлов, пока запуск не раскрыли', () => {
  const r = loadRenderer();
  const html = r.historyFilesHtml({
    files: [
      { action: 'copy', path: 'а/б.txt' },
      { action: 'trash', path: 'в/г.txt' },
    ],
  });
  assert.match(html, /а\/б\.txt/);
  assert.match(html, /в\/г\.txt/);

  const dropped = r.historyFilesHtml({ detailsDropped: true, fileCount: 4321 });
  assert.match(dropped, /не сохранён/, 'о срезанном перечне говорим прямо');
  assert.match(dropped, /4\s?321/, 'счётчик показываем');
});
