'use strict';

// IPC-обработчики main.js на настоящих временных папках: тот же путь, которым
// ходит интерфейс, только без Электрона. Проверяется связка целиком —
// листинг, предпросмотр, синхронизация, кеши, история, отказы.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const { loadMain, tmpDir, writeFile, snapshot } = require('./helpers/main-harness');

// main.js держит состояние (кеши, токены, замок синхронизации) в модуле,
// поэтому поднимаем его один раз на файл — как и в живом приложении.
const ready = loadMain();

test('листинг схлопывает разное написание в одну строку и помечает обе стороны', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'Отчёты/a.txt', '1');
  await writeFile(network, 'отчёты/b.txt', '2');
  await writeFile(network, 'Только-в-сети/c.txt', '3');

  const r = await call('list-folders', { localPath: local, networkPath: network, relPath: '' });

  assert.strictEqual(r.items.length, 2, 'одна папка в двух написаниях — одна строка');
  const общая = r.items.find((i) => i.name.toLowerCase() === 'отчёты');
  assert.ok(общая.hasLocal && общая.hasNetwork);
  assert.strictEqual(r.localOk, true);
  assert.strictEqual(r.networkOk, true);
});

test('листинг отличает недоступную сторону от пустой', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  const r = await call('list-folders', {
    localPath: path.join(local, 'нет-такой'),
    networkPath: network,
    relPath: '',
  });
  assert.strictEqual(r.localOk, false);
  assert.strictEqual(r.networkOk, true);
});

test('предпросмотр и синхронизация: стороны сходятся, повтор пуст', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'док/новый.txt', 'новое');
  await writeFile(local, 'док/общий.txt', 'одинаково');
  await writeFile(network, 'док/общий.txt', 'одинаково');
  await writeFile(network, 'док/лишний.txt', 'убрать');

  const args = { localPath: local, networkPath: network, folders: ['док'], excludes: [], direction: 'toNetwork' };
  const pv = await call('preview', args);
  assert.strictEqual(pv.totals.copy, 1);
  assert.strictEqual(pv.totals.trash, 1);
  assert.strictEqual(
    pv.perFolder[0].summary.total,
    pv.totals.total,
    'сумма по веткам обязана сходиться с шапкой'
  );

  const res = await call('sync', args);
  assert.ok(!res.error);
  assert.strictEqual(res.failures, 0);
  assert.deepStrictEqual(await snapshot(local), await snapshot(network));

  const again = await call('preview', args);
  assert.strictEqual(again.totals.total, 0, 'повторный прогон не находит работы');
});

test('план по индексу фонового обхода совпадает с планом по живому скану', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'док/новый.txt', 'новое');
  await writeFile(network, 'док/лишний.txt', 'убрать');

  const args = { localPath: local, networkPath: network, folders: ['док'], excludes: [], direction: 'toNetwork' };
  const живой = await call('preview', args);
  await call('start-crawl', { localPath: local, networkPath: network });
  const поИндексу = await call('preview', args);

  assert.deepStrictEqual(поИндексу.totals, живой.totals);
});

test('исключённая ветка не копируется и не удаляется', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'док/внутри/a.txt', 'A');
  await writeFile(local, 'док/скрыто/b.txt', 'B');
  await writeFile(network, 'док/скрыто/своё.txt', 'не трогать');

  await call('sync', {
    localPath: local, networkPath: network,
    folders: ['док'], excludes: ['док/скрыто'], direction: 'toNetwork',
  });

  assert.ok(fs.existsSync(path.join(network, 'док/скрыто/своё.txt')), 'чужое в исключении цело');
  assert.ok(!fs.existsSync(path.join(network, 'док/скрыто/b.txt')), 'исключённое не копируется');
  assert.ok(fs.existsSync(path.join(network, 'док/внутри/a.txt')));
});

test('вложенная ветка внутри исключённой всё-таки синхронизируется', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'док/a/b/нужный.txt', 'нужен');
  await writeFile(local, 'док/a/мимо.txt', 'мимо');
  await writeFile(local, 'док/прочее.txt', 'обычный');

  await call('sync', {
    localPath: local, networkPath: network,
    folders: ['док', 'док/a/b'], excludes: ['док/a'], direction: 'toNetwork',
  });

  assert.ok(fs.existsSync(path.join(network, 'док/a/b/нужный.txt')));
  assert.ok(!fs.existsSync(path.join(network, 'док/a/мимо.txt')));
  assert.ok(fs.existsSync(path.join(network, 'док/прочее.txt')));
});

test('недоступный источник: синхронизация не начинается, приёмник цел', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(network, 'док/ценное.txt', 'не удалять');

  const res = await call('sync', {
    localPath: path.join(local, 'нет-такой'), networkPath: network,
    folders: ['док'], excludes: [], direction: 'toNetwork',
  });

  assert.ok(res.error, 'должен быть отказ, а не пустой план');
  assert.ok(!res.started, 'приёмник не тронут — так и сообщаем');
  assert.ok(fs.existsSync(path.join(network, 'док/ценное.txt')));
});

test('вложенные корни отклоняются', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  await writeFile(local, 'внутри/x.txt', '1');
  const res = await call('sync', {
    localPath: local, networkPath: path.join(local, 'внутри'),
    folders: ['внутри'], excludes: [], direction: 'toNetwork',
  });
  assert.match(res.error, /вложены друг в друга/);
});

// Два запуска разом делят служебную папку: restoreStage второго возвращает
// оригиналы прямо из-под первого, который в этот момент ими и занят.
test('второй одновременный запуск отклоняется, а не портит приёмник', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  for (let i = 0; i < 30; i += 1) await writeFile(local, `док/ф${i}.txt`, 'новое');
  for (let i = 0; i < 30; i += 1) await writeFile(network, `док/ф${i}.txt`, 'старое-другой-длины');

  const args = { localPath: local, networkPath: network, folders: ['док'], excludes: [], direction: 'toNetwork' };
  const [a, b] = await Promise.all([call('sync', args), call('sync', args)]);

  const отказов = [a, b].filter((r) => r.error).length;
  assert.strictEqual(отказов, 1, 'ровно один запуск должен быть отклонён');
  assert.strictEqual([a, b].find((r) => !r.error).unrecoverable, 0);
  assert.deepStrictEqual(await snapshot(local), await snapshot(network));
  assert.ok(!fs.existsSync(path.join(network, '.sgundo')));
});

test('остановка посреди работы возвращает приёмник как было', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  for (let i = 0; i < 150; i += 1) await writeFile(local, `док/новый${i}.txt`, 'новое');
  for (let i = 0; i < 150; i += 1) await writeFile(network, `док/старый${i}.txt`, 'старое');

  const before = await snapshot(network);
  const running = call('sync', {
    localPath: local, networkPath: network, folders: ['док'], excludes: [], direction: 'toNetwork',
  });
  await new Promise((r) => setTimeout(r, 10));
  await call('cancel-sync', {});
  const res = await running;

  if (res.cancelled) {
    assert.deepStrictEqual(await snapshot(network), before, 'откат обязан быть полным');
    assert.ok(!fs.existsSync(path.join(network, '.sgundo')));
  }
});

// Оборвавшийся запуск мог идти в другую сторону: тогда оригиналы лежат в том
// корне, который сейчас источник. Не разобрать их — принять за пропавшие.
test('брошенные оригиналы разбираются на обеих сторонах', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'док/общий.txt', 'одинаково');
  await writeFile(network, 'док/общий.txt', 'одинаково');
  await writeFile(local, '.sgundo/док/брошенный.txt', 'вернуть на место');

  await call('sync', {
    localPath: local, networkPath: network, folders: ['док'], excludes: [], direction: 'toNetwork',
  });

  assert.ok(fs.existsSync(path.join(local, 'док/брошенный.txt')), 'вернулся на источник');
  assert.ok(fs.existsSync(path.join(network, 'док/брошенный.txt')), 'и доехал до приёмника');
});

test('конфликт «папка против файла» разрешается в пользу источника', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'док/узел', 'на источнике это файл');
  await writeFile(network, 'док/узел/внутри.txt', 'на приёмнике это папка');

  await call('sync', {
    localPath: local, networkPath: network, folders: ['док'], excludes: [], direction: 'toNetwork',
  });

  const узел = path.join(network, 'док/узел');
  assert.ok(fs.statSync(узел).isFile());
  assert.strictEqual(fs.readFileSync(узел, 'utf8'), 'на источнике это файл');
});

test('история перечисляет ровно то, что обещает сводка, удаления первыми', async () => {
  const { call, userData } = await ready;
  const local = await tmpDir();
  const network = await tmpDir();
  await fsp.rm(path.join(userData, 'history.json'), { force: true });
  for (let i = 0; i < 5; i += 1) await writeFile(local, `д/новый${i}.txt`, 'x');
  for (let i = 0; i < 3; i += 1) await writeFile(network, `д/лишний${i}.txt`, 'y');

  await call('sync', {
    localPath: local, networkPath: network, folders: ['д'], excludes: [], direction: 'toNetwork',
  });
  const [run] = await call('get-history', {});

  const { move = 0, copy = 0, overwrite = 0, trash = 0 } = run.totals;
  assert.strictEqual(run.files.length, move + copy + overwrite + trash);
  assert.strictEqual(run.files[0].action, 'trash', 'удаления в истории идут первыми');
});

test('битые файлы состояния не роняют приложение', async () => {
  const { call, userData } = await ready;
  await fsp.writeFile(path.join(userData, 'settings.json'), '{это не json');
  assert.deepStrictEqual(await call('get-settings', {}), {});

  await fsp.writeFile(path.join(userData, 'history.json'), '{"не":"массив"}');
  assert.deepStrictEqual(await call('get-history', {}), []);
});

test('probe различает доступную и недоступную сторону', async () => {
  const { call } = await ready;
  const local = await tmpDir();
  const r = await call('probe', { localPath: local, networkPath: path.join(local, 'нет') });
  assert.strictEqual(r.localOk, true);
  assert.strictEqual(r.networkOk, false);

  const пусто = await call('probe', { localPath: '', networkPath: '' });
  assert.strictEqual(пусто.localOk, false);
  assert.strictEqual(пусто.networkOk, false);
});
