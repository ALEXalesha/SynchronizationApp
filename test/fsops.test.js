'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const {
  scanFiles,
  listTopFolders,
  listTopFolderNames,
  listChildren,
  crawlTree,
  applyPlan,
} = require('../src/fsops');
const { planSync } = require('../src/sync');
const { pruneDescendants } = require('../src/paths');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-'));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

test('scanFiles обходит вложенные папки и пропускает несуществующие', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'a.txt', 'hello');
  await writeFile(dir, 'sub/b.txt', 'world!!');
  const files = await scanFiles(dir);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.ok(byPath['a.txt']);
  assert.ok(byPath['sub/b.txt']);
  assert.strictEqual(byPath['a.txt'].size, 5);
  assert.strictEqual((await scanFiles(path.join(dir, 'nope'))).length, 0);
});

test('listTopFolders считает файлы и размер по папкам', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'docs/a.txt', '123');
  await writeFile(dir, 'docs/sub/b.txt', '45');
  await writeFile(dir, 'pics/c.txt', '6789');
  const folders = await listTopFolders(dir);
  const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
  assert.strictEqual(byName['docs'].fileCount, 2);
  assert.strictEqual(byName['docs'].size, 5);
  assert.strictEqual(byName['pics'].fileCount, 1);
  assert.strictEqual(byName['pics'].size, 4);
});

test('listTopFolderNames — только имена прямых подпапок, без рекурсии', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'docs/2024/a.txt', '1');
  await writeFile(dir, 'pics/b.txt', '2');
  await writeFile(dir, 'root.txt', '3'); // файл в корне не считается папкой
  const names = await listTopFolderNames(dir);
  assert.deepStrictEqual(names, ['docs', 'pics']);
});

test('синхронизация вложенной ветки не трогает соседей', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();

  // Общая структура на обеих сторонах.
  await writeFile(src, 'docs/2023/old.txt', 'src-2023');
  await writeFile(src, 'docs/2024/new.txt', 'src-2024');
  await writeFile(src, 'pics/photo.txt', 'src-pic');
  await writeFile(dst, 'docs/2023/old.txt', 'DST-2023-different'); // отличается
  await writeFile(dst, 'docs/2024/stale.txt', 'to-remove'); // лишний в выбранной ветке
  await writeFile(dst, 'pics/photo.txt', 'DST-pic-different'); // сосед, НЕ выбран

  // Пользователь выбрал только docs/2024.
  const branches = pruneDescendants(['docs/2024']);
  assert.deepStrictEqual(branches, ['docs/2024']);

  for (const folder of branches) {
    const [s, d] = [
      await scanFiles(path.join(src, folder)),
      await scanFiles(path.join(dst, folder)),
    ];
    const plan = planSync(s, d);
    await applyPlan(path.join(src, folder), path.join(dst, folder), plan, async (abs) =>
      fsp.rm(abs)
    );
  }

  // docs/2024 приведён к копии источника.
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/2024/new.txt'), 'utf8'), 'src-2024');
  assert.strictEqual(fs.existsSync(path.join(dst, 'docs/2024/stale.txt')), false);
  // Соседи НЕ тронуты.
  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'docs/2023/old.txt'), 'utf8'),
    'DST-2023-different'
  );
  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'pics/photo.txt'), 'utf8'),
    'DST-pic-different'
  );
});

test('listChildren возвращает и папки, и файлы с пометкой типа', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'sub/x.txt', '1');
  await writeFile(dir, 'file.txt', '2');
  const children = await listChildren(dir);
  const byName = Object.fromEntries(children.map((c) => [c.name, c.isDir]));
  assert.strictEqual(byName['sub'], true);
  assert.strictEqual(byName['file.txt'], false);
  assert.strictEqual(children.length, 2);
});

test('crawlTree считает размеры и количество файлов по узлам', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'docs/a.txt', 'AAAAA'); // 5 байт
  await writeFile(dir, 'docs/sub/b.txt', 'BB'); // 2 байта
  await writeFile(dir, 'root.txt', 'CCC'); // 3 байта

  const seen = new Map();
  const total = await crawlTree(dir, '', (rel, isDir, size, cnt) => {
    seen.set(rel, { isDir, size, cnt });
  });

  assert.strictEqual(total.size, 10);
  assert.strictEqual(total.count, 3);
  assert.strictEqual(seen.get('docs').isDir, true);
  assert.strictEqual(seen.get('docs').size, 7); // 5 + 2
  assert.strictEqual(seen.get('docs').cnt, 2);
  assert.strictEqual(seen.get('root.txt').isDir, false);
  assert.strictEqual(seen.get('root.txt').size, 3);
});

test('scanFiles пропускает исключённые ветки', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'keep/a.txt', '1');
  await writeFile(dir, 'skip/b.txt', '2');
  await writeFile(dir, 'skip/deep/c.txt', '3');
  const files = await scanFiles(dir, '', [], new Set(['skip']));
  assert.deepStrictEqual(files.map((f) => f.path).sort(), ['keep/a.txt']);
});

test('исключённая подпапка не копируется и не удаляется', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();

  await writeFile(src, 'docs/2024/a.txt', 'src-a');
  await writeFile(src, 'docs/2023/b.txt', 'src-b');
  await writeFile(src, 'docs/root.txt', 'src-root');
  await writeFile(dst, 'docs/2024/OLD.txt', 'dst-old'); // в исключённой ветке
  await writeFile(dst, 'docs/extra.txt', 'dst-extra'); // лишний, НЕ исключён

  // Выбрана ветка docs, но docs/2024 исключена. excludes относительно ветки docs.
  const ex = new Set(['2024']);
  const srcRoot = path.join(src, 'docs');
  const dstRoot = path.join(dst, 'docs');
  const plan = planSync(
    await scanFiles(srcRoot, '', [], ex),
    await scanFiles(dstRoot, '', [], ex)
  );
  await applyPlan(srcRoot, dstRoot, plan, async (abs) => fsp.rm(abs));

  // Исключённая ветка не тронута с обеих сторон.
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/2024/OLD.txt'), 'utf8'), 'dst-old');
  assert.strictEqual(fs.existsSync(path.join(dst, 'docs/2024/a.txt')), false);
  // Остальное синхронизировано: b скопирован, extra удалён.
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/2023/b.txt'), 'utf8'), 'src-b');
  assert.strictEqual(fs.existsSync(path.join(dst, 'docs/extra.txt')), false);
});

test('applyPlan копирует, перезаписывает и удаляет (в мок-корзину)', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();

  // источник: a (новый), b (изменён)
  await writeFile(src, 'a.txt', 'new file');
  await writeFile(src, 'b.txt', 'updated content');
  // приёмник: b (старый), c (лишний)
  await writeFile(dst, 'b.txt', 'old');
  await writeFile(dst, 'c.txt', 'to be removed');

  const plan = planSync(await scanFiles(src), await scanFiles(dst));

  const trashed = [];
  const trashFn = async (abs) => {
    trashed.push(abs);
    await fsp.rm(abs);
  };

  const res = await applyPlan(src, dst, plan, trashFn);

  assert.strictEqual(res.total, 3); // copy a, overwrite b, trash c
  assert.strictEqual(await fsp.readFile(path.join(dst, 'a.txt'), 'utf8'), 'new file');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'b.txt'), 'utf8'), 'updated content');
  assert.strictEqual(fs.existsSync(path.join(dst, 'c.txt')), false);
  assert.strictEqual(trashed.length, 1);

  // Повторный проход не находит различий (mtime перенесён при копировании).
  const plan2 = planSync(await scanFiles(src), await scanFiles(dst));
  assert.strictEqual(plan2.copy.length + plan2.overwrite.length + plan2.trash.length, 0);
});
