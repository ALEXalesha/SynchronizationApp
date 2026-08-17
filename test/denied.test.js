'use strict';

// Папки, закрытые правами. До этих тестов одна такая папка обрывала весь обход:
// предпросмотр отвечал EPERM, синхронизация не начиналась, размеры не считались.
// Подменить её содержимое пустым списком нельзя — пустой источник означает
// «на приёмнике всё лишнее», — поэтому ветка выбывает из плана на обеих сторонах.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const { scanFiles, crawlTree, applyPlan } = require('../src/fsops');
const { buildRunPlan, scanFromIndex } = require('../src/plan');
const { loadMain } = require('./helpers/main-harness');

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-acl-'));

// Закрывает папку от текущего пользователя. Возвращает функцию, которая вернёт
// доступ обратно: без неё каталог не удалить даже уборкой после теста.
function denyAccess(dir) {
  const me = process.env.USERNAME;
  execFileSync('icacls', [dir, '/inheritance:r', '/deny', `${me}:(OI)(CI)(RX)`], { stdio: 'pipe' });
  return () => execFileSync('icacls', [dir, '/grant', `${me}:(OI)(CI)F`], { stdio: 'pipe' });
}

async function write(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

const scanner = (root, branch, excludes) => {
  const prefix = branch ? `${branch}/` : '';
  const set = new Set();
  for (const ex of excludes) {
    if (prefix && ex.length > prefix.length && ex.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
      set.add(ex.slice(prefix.length));
    } else if (!prefix) set.add(ex);
  }
  const dirs = [];
  const skipped = [];
  return scanFiles(path.join(root, branch), '', [], set, null, null, dirs, skipped)
    .then((files) => ({ files, dirs, skipped }));
};

test('закрытая правами папка не обрывает обход, а возвращается отдельным списком', async (t) => {
  const root = await tmpDir();
  await write(root, 'ok/a.txt', 'a');
  await write(root, 'locked/secret.txt', 's');
  const restore = denyAccess(path.join(root, 'locked'));
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const dirs = [];
  const skipped = [];
  const files = await scanFiles(root, '', [], null, null, null, dirs, skipped);

  assert.deepStrictEqual(files.map((f) => f.path), ['ok/a.txt']);
  assert.deepStrictEqual(skipped, ['locked']);
  // Сама папка остаётся в структуре: она существует, просто внутрь не пускают.
  assert.ok(dirs.includes('locked'), 'закрытая папка должна остаться в списке папок');
});

test('обход размеров переживает закрытую папку и называет её', async (t) => {
  const root = await tmpDir();
  await write(root, 'ok/a.txt', 'aaa');
  await write(root, 'locked/secret.txt', 's');
  const restore = denyAccess(path.join(root, 'locked'));
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const skipped = [];
  const seen = [];
  const agg = await crawlTree(root, '', (rel) => seen.push(rel), null, skipped);

  assert.deepStrictEqual(skipped, ['locked']);
  assert.strictEqual(agg.count, 1, 'посчитан только доступный файл');
  assert.ok(seen.includes('ok/a.txt'));
});

test('содержимое закрытой папки не удаляется с приёмника', async (t) => {
  // Главный случай: на источнике папка закрыта правами, на приёмнике её копия
  // видна целиком. Читай мы закрытую ветку как пустую — приёмник лишился бы
  // всего её содержимого, потому что «на источнике этого нет».
  const src = await tmpDir();
  const dst = await tmpDir();
  await write(src, 'data/keep.txt', 'k');
  await write(src, 'data/locked/inside.txt', 'i');
  await write(dst, 'data/keep.txt', 'k');
  await write(dst, 'data/locked/inside.txt', 'i');
  await write(dst, 'data/locked/extra.txt', 'e');
  const restore = denyAccess(path.join(src, 'data', 'locked'));
  t.after(async () => {
    restore();
    await fsp.rm(src, { recursive: true, force: true });
    await fsp.rm(dst, { recursive: true, force: true });
  });

  const plan = await buildRunPlan(src, dst, ['data'], [], scanner);

  assert.deepStrictEqual(plan.trash, [], 'ничего из закрытой ветки не уходит в Корзину');
  assert.deepStrictEqual(plan.dirs.remove, [], 'закрытая папка не считается лишней');
  assert.deepStrictEqual(plan.skipped, ['data/locked']);

  const trashed = [];
  await applyPlan(src, dst, plan, async (p) => {
    trashed.push(p);
    await fsp.rm(p, { recursive: true, force: true });
  });

  assert.strictEqual(await fsp.readFile(path.join(dst, 'data/locked/extra.txt'), 'utf8'), 'e');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'data/locked/inside.txt'), 'utf8'), 'i');
});

test('закрытая папка на приёмнике не наполняется вслепую с источника', async (t) => {
  // Обратная сторона: заглянуть в приёмник не дают, значит и сравнивать нечего.
  // Копировать туда наугад — верный способ получить горсть ошибок на каждом файле.
  const src = await tmpDir();
  const dst = await tmpDir();
  await write(src, 'data/locked/inside.txt', 'i');
  await write(src, 'data/open.txt', 'o');
  await write(dst, 'data/locked/inside.txt', 'i');
  const restore = denyAccess(path.join(dst, 'data', 'locked'));
  t.after(async () => {
    restore();
    await fsp.rm(src, { recursive: true, force: true });
    await fsp.rm(dst, { recursive: true, force: true });
  });

  const plan = await buildRunPlan(src, dst, ['data'], [], scanner);

  assert.deepStrictEqual(plan.copy.map((e) => e.path), ['data/open.txt']);
  assert.deepStrictEqual(plan.skipped, ['data/locked']);
});

test('индекс обхода обходит закрытую папку так же, как живой скан', async (t) => {
  // Один и тот же выбор обязан давать один и тот же план независимо от того,
  // включён ли подсчёт размеров: иначе разницу нельзя ни увидеть, ни объяснить.
  const src = await tmpDir();
  const dst = await tmpDir();
  await write(src, 'data/keep.txt', 'k');
  await write(src, 'data/locked/inside.txt', 'i');
  await write(dst, 'data/keep.txt', 'k');
  await write(dst, 'data/locked/inside.txt', 'i');
  await write(dst, 'data/locked/extra.txt', 'e');
  const restore = denyAccess(path.join(src, 'data', 'locked'));
  t.after(async () => {
    restore();
    await fsp.rm(src, { recursive: true, force: true });
    await fsp.rm(dst, { recursive: true, force: true });
  });

  const indexOf = async (root) => {
    const files = new Map();
    const dirs = new Set();
    const skipped = [];
    await crawlTree(root, '', (rel, isFolder, size, cnt, mtimeMs) => {
      if (isFolder) dirs.add(rel);
      else files.set(rel, { size, mtimeMs });
    }, null, skipped);
    return { files, dirs, skipped };
  };
  const idx = { [src]: await indexOf(src), [dst]: await indexOf(dst) };
  const byIndex = (root, branch, excludes) => scanFromIndex(idx[root], branch, excludes);

  const live = await buildRunPlan(src, dst, ['data'], [], scanner);
  const indexed = await buildRunPlan(src, dst, ['data'], [], byIndex);

  const shape = (p) => JSON.stringify({
    copy: p.copy.map((e) => e.path).sort(),
    trash: p.trash.map((e) => e.path).sort(),
    remove: p.dirs.remove.sort(),
    skipped: p.skipped.sort(),
  });
  assert.strictEqual(shape(indexed), shape(live));
  assert.deepStrictEqual(indexed.skipped, ['data/locked']);
});

test('нечитаемый корень — это недоступная сторона, а не пустая', async (t) => {
  // Достоверность списка решалась отдельным stat, а stat по закрытой правами
  // папке проходит — readdir нет. Сторона объявлялась доступной с пустым списком,
  // и интерфейс, поверив ответу, стирал отметки папок, которые жили только на ней.
  // Список верхнего уровня обновляется каждые 6 секунд, так что одна осечка
  // чтения уносила весь выбор пользователя.
  const { call } = await loadMain();
  const local = await tmpDir();
  const network = await tmpDir();
  await write(local, 'док/а.txt', 'a');
  await write(network, 'док/а.txt', 'a');

  const ok = await call('list-folders', { localPath: local, networkPath: network, relPath: '' });
  assert.strictEqual(ok.localOk, true);
  assert.strictEqual(ok.items.length, 1);

  const restore = denyAccess(local);
  t.after(async () => {
    restore();
    await fsp.rm(local, { recursive: true, force: true });
    await fsp.rm(network, { recursive: true, force: true });
  });

  const denied = await call('list-folders', {
    localPath: local,
    networkPath: network,
    relPath: '',
    force: true,
  });
  assert.strictEqual(denied.localOk, false, 'корень не прочитан — верить списку нельзя');
  assert.strictEqual(denied.networkOk, true, 'вторая сторона по-прежнему годится к показу');
});

test('закрыт сам корень выбранной ветки — ветка выбывает целиком', async (t) => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await write(src, 'locked/inside.txt', 'i');
  await write(dst, 'locked/other.txt', 'o');
  const restore = denyAccess(path.join(src, 'locked'));
  t.after(async () => {
    restore();
    await fsp.rm(src, { recursive: true, force: true });
    await fsp.rm(dst, { recursive: true, force: true });
  });

  const plan = await buildRunPlan(src, dst, ['locked'], [], scanner);

  assert.deepStrictEqual(plan.trash, [], 'чужой файл на приёмнике не удаляется');
  assert.deepStrictEqual(plan.copy, []);
  assert.deepStrictEqual(plan.skipped, ['locked']);
});
