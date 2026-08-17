'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const {
  scanFiles,
  listChildren,
  crawlTree,
  applyPlan,
  restoreStage,
  STAGE_DIR,
} = require('../src/fsops');
const { planSync, detectMoves, planDirs } = require('../src/sync');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-'));
}

// Мок Корзины: applyPlan отдаёт сюда служебную папку целиком, поэтому recursive.
function mockTrash(collected) {
  return async (abs) => {
    collected.push(abs);
    await fsp.rm(abs, { recursive: true, force: true });
  };
}

async function treeOf(dir, rel = '', out = []) {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    out.push(d.isDirectory() ? `${r}/` : r);
    if (d.isDirectory()) await treeOf(dir, r, out);
  }
  return out.sort();
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
  // Пользователь выбрал только docs/2024.
  for (const folder of ['docs/2024']) {
    const [s, d] = [
      await scanFiles(path.join(src, folder)),
      await scanFiles(path.join(dst, folder)),
    ];
    const plan = planSync(s, d);
    await applyPlan(path.join(src, folder), path.join(dst, folder), plan, mockTrash([]));
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
  const { items, ok } = await listChildren(dir);
  const byName = Object.fromEntries(items.map((c) => [c.name, c.isDir]));
  assert.strictEqual(ok, true);
  assert.strictEqual(byName['sub'], true);
  assert.strictEqual(byName['file.txt'], false);
  assert.strictEqual(items.length, 2);
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
  await applyPlan(srcRoot, dstRoot, plan, mockTrash([]));

  // Исключённая ветка не тронута с обеих сторон.
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/2024/OLD.txt'), 'utf8'), 'dst-old');
  assert.strictEqual(fs.existsSync(path.join(dst, 'docs/2024/a.txt')), false);
  // Остальное синхронизировано: b скопирован, extra удалён.
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/2023/b.txt'), 'utf8'), 'src-b');
  assert.strictEqual(fs.existsSync(path.join(dst, 'docs/extra.txt')), false);
});

test('applyPlan не падает на ошибке файла, копит failures и продолжает', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'a.txt', 'A');
  await writeFile(src, 'b.txt', 'B');
  await writeFile(dst, 'x.txt', 'X'); // лишний → в trash, но trashFn бросит EPERM

  const plan = planSync(await scanFiles(src), await scanFiles(dst));
  const res = await applyPlan(src, dst, plan, async () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  });

  // Копирование прошло несмотря на ошибку удаления.
  assert.strictEqual(await fsp.readFile(path.join(dst, 'a.txt'), 'utf8'), 'A');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'b.txt'), 'utf8'), 'B');
  assert.strictEqual(res.failures.length, 1);
  assert.strictEqual(res.failures[0].action, 'trash');
  assert.strictEqual(res.failures[0].code, 'EPERM');
});

test('applyPlan параллельно обрабатывает много файлов корректно', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  for (let i = 0; i < 200; i += 1) await writeFile(src, `sub${i % 7}/f${i}.txt`, `data-${i}`);
  for (let i = 0; i < 50; i += 1) await writeFile(dst, `old/x${i}.txt`, 'stale'); // лишние → trash

  const plan = planSync(await scanFiles(src), await scanFiles(dst));
  const trashed = [];
  const res = await applyPlan(src, dst, plan, mockTrash(trashed));

  assert.strictEqual(res.failures.length, 0);
  assert.strictEqual(res.done, res.total);
  // Все 200 файлов на месте с верным содержимым.
  for (let i = 0; i < 200; i += 1) {
    assert.strictEqual(await fsp.readFile(path.join(dst, `sub${i % 7}/f${i}.txt`), 'utf8'), `data-${i}`);
  }
  // Все 50 лишних файлов удалены одной пачкой.
  assert.strictEqual(trashed.length, 1);
  assert.strictEqual(res.trashed, 50);
  for (let i = 0; i < 50; i += 1) {
    assert.strictEqual(fs.existsSync(path.join(dst, `old/x${i}.txt`)), false);
  }
  assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false);
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
  const res = await applyPlan(src, dst, plan, mockTrash(trashed));

  assert.strictEqual(res.total, 3); // copy a, overwrite b, trash c
  assert.strictEqual(await fsp.readFile(path.join(dst, 'a.txt'), 'utf8'), 'new file');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'b.txt'), 'utf8'), 'updated content');
  assert.strictEqual(fs.existsSync(path.join(dst, 'c.txt')), false);
  assert.strictEqual(trashed.length, 1);

  // Повторный проход не находит различий (mtime перенесён при копировании).
  const plan2 = planSync(await scanFiles(src), await scanFiles(dst));
  assert.strictEqual(plan2.copy.length + plan2.overwrite.length + plan2.trash.length, 0);
});

// ---- Перемещения ----

test('перемещение файла в другую папку распознаётся и не копируется заново', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'A/big.bin', 'x'.repeat(4096));
  await writeFile(src, 'A/stay.txt', 'stay');
  await fsp.cp(src, dst, { recursive: true });
  await fsp.mkdir(path.join(src, 'B'), { recursive: true });
  await fsp.rename(path.join(src, 'A/big.bin'), path.join(src, 'B/big.bin'));

  const plan = detectMoves(planSync(await scanFiles(src), await scanFiles(dst)));
  assert.strictEqual(plan.moves.length, 1);
  assert.strictEqual(plan.moves[0].from, 'A/big.bin');
  assert.strictEqual(plan.moves[0].to, 'B/big.bin');
  assert.strictEqual(plan.copy.length, 0);
  assert.strictEqual(plan.trash.length, 0);

  const trashed = [];
  const res = await applyPlan(src, dst, plan, mockTrash(trashed));
  assert.strictEqual(res.failures.length, 0);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'B/big.bin'), 'utf8'), 'x'.repeat(4096));
  assert.strictEqual(fs.existsSync(path.join(dst, 'A/big.bin')), false);
  assert.strictEqual(trashed.length, 0); // ничего не удалялось
});

test('переименование папки — это перемещения всех её файлов', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  for (let i = 0; i < 5; i += 1) await writeFile(src, `Старая/f${i}.txt`, `данные-${i}`);
  await fsp.cp(src, dst, { recursive: true });
  await fsp.rename(path.join(src, 'Старая'), path.join(src, 'Новая'));

  const srcDirs = [];
  const dstDirs = [];
  const plan = detectMoves(
    planSync(
      await scanFiles(src, '', [], null, null, null, srcDirs),
      await scanFiles(dst, '', [], null, null, null, dstDirs)
    )
  );
  plan.dirs = planDirs(srcDirs, dstDirs);

  assert.strictEqual(plan.moves.length, 5);
  assert.strictEqual(plan.copy.length, 0);
  assert.deepStrictEqual(plan.dirs.create, ['Новая']);
  assert.deepStrictEqual(plan.dirs.remove, ['Старая']);

  await applyPlan(src, dst, plan, mockTrash([]));
  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
});

test('одинаковые размер, дата и имя в разных папках — перемещение не угадывается', async () => {
  const same = { size: 10, mtimeMs: 5000 };
  const plan = detectMoves(
    planSync(
      [{ path: 'c/doc.txt', ...same }, { path: 'd/doc.txt', ...same }],
      [{ path: 'a/doc.txt', ...same }, { path: 'b/doc.txt', ...same }]
    )
  );
  assert.strictEqual(plan.moves.length, 0);
  assert.strictEqual(plan.copy.length, 2);
  assert.strictEqual(plan.trash.length, 2);
});

test('разные имена не признаются переносом, даже при совпадении размера и даты', async () => {
  // Раньше такая пара считалась переносом с переименованием. Но размер и дата
  // до миллисекунды совпадают и у совершенно разных файлов (распаковка архива,
  // git checkout, robocopy ставят метки пачкой), и приёмник получал чужое
  // содержимое молча. Копируем — медленнее, зато верно.
  const plan = detectMoves(
    planSync(
      [{ path: 'Архив/отчёт-2024.pdf', size: 999, mtimeMs: 7000 }],
      [{ path: 'Входящие/scan001.pdf', size: 999, mtimeMs: 7000 }]
    )
  );
  assert.strictEqual(plan.moves.length, 0);
  assert.strictEqual(plan.copy.length, 1);
  assert.strictEqual(plan.trash.length, 1);
});

test('перенос с сохранением имени по-прежнему ловится', async () => {
  const plan = detectMoves(
    planSync(
      [{ path: 'Архив/2024/отчёт.pdf', size: 999, mtimeMs: 7000 }],
      [{ path: 'Входящие/отчёт.pdf', size: 999, mtimeMs: 7000 }]
    )
  );
  assert.strictEqual(plan.moves.length, 1);
  assert.strictEqual(plan.moves[0].from, 'Входящие/отчёт.pdf');
  assert.strictEqual(plan.moves[0].to, 'Архив/2024/отчёт.pdf');
});

test('пустые папки создаются и лишние убираются', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await fsp.mkdir(path.join(src, 'ПустаяНовая'), { recursive: true });
  await writeFile(src, 'Общая/a.txt', 'a');
  await writeFile(dst, 'Общая/a.txt', 'a');
  await fsp.mkdir(path.join(dst, 'Лишняя/Глубже'), { recursive: true });

  const srcDirs = [];
  const dstDirs = [];
  const plan = planSync(
    await scanFiles(src, '', [], null, null, null, srcDirs),
    await scanFiles(dst, '', [], null, null, null, dstDirs)
  );
  plan.dirs = planDirs(srcDirs, dstDirs);
  // Глубокие первыми, иначе rmdir родителя упрётся в непустую папку.
  assert.deepStrictEqual(plan.dirs.remove, ['Лишняя/Глубже', 'Лишняя']);

  await applyPlan(src, dst, plan, mockTrash([]));
  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
});

test('rmdir не сносит папку, в которой осталось исключённое', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(dst, 'Лишняя/секрет.txt', 'не трогать');

  const plan = planSync([], []);
  plan.dirs = { create: [], remove: ['Лишняя'] };
  await applyPlan(src, dst, plan, mockTrash([]));

  assert.strictEqual(await fsp.readFile(path.join(dst, 'Лишняя/секрет.txt'), 'utf8'), 'не трогать');
});

// ---- Остановка и откат ----

test('остановка откатывает копирование, перезапись, удаление и перемещение', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();

  await writeFile(src, 'move-me.bin', 'MOVED');
  await writeFile(src, 'upd.txt', 'новое содержимое');
  for (let i = 0; i < 40; i += 1) await writeFile(src, `new/n${i}.txt`, `new-${i}`);
  await fsp.mkdir(path.join(src, 'НоваяПустая'), { recursive: true });

  await writeFile(dst, 'old/move-me.bin', 'MOVED');
  await writeFile(dst, 'upd.txt', 'старое');
  for (let i = 0; i < 40; i += 1) await writeFile(dst, `stale/s${i}.txt`, `stale-${i}`);

  // Дата у перемещаемого файла должна совпасть, иначе пара не найдётся.
  const st = await fsp.stat(path.join(src, 'move-me.bin'));
  await fsp.utimes(path.join(dst, 'old/move-me.bin'), st.atime, st.mtime);

  const before = await treeOf(dst);
  const updBefore = await fsp.readFile(path.join(dst, 'upd.txt'), 'utf8');

  const srcDirs = [];
  const dstDirs = [];
  const plan = detectMoves(
    planSync(
      await scanFiles(src, '', [], null, null, null, srcDirs),
      await scanFiles(dst, '', [], null, null, null, dstDirs)
    )
  );
  plan.dirs = planDirs(srcDirs, dstDirs);
  assert.strictEqual(plan.moves.length, 1);

  // Останавливаем на середине работы.
  let seen = 0;
  const res = await applyPlan(src, dst, plan, mockTrash([]), () => {
    seen += 1;
  }, { shouldStop: () => seen >= 20 });

  assert.strictEqual(res.cancelled, true);
  assert.deepStrictEqual(await treeOf(dst), before);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'upd.txt'), 'utf8'), updBefore);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'old/move-me.bin'), 'utf8'), 'MOVED');
  assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false);
});

test('оборванный запуск: restoreStage возвращает оригиналы из служебной папки', async () => {
  const dst = await tmpDir();
  await writeFile(dst, `${STAGE_DIR}/docs/важное.txt`, 'оригинал');
  await writeFile(dst, `${STAGE_DIR}/корень.txt`, 'тоже оригинал');

  const restored = await restoreStage(dst);
  assert.strictEqual(restored, 2);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/важное.txt'), 'utf8'), 'оригинал');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'корень.txt'), 'utf8'), 'тоже оригинал');
  assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false);
});

test('служебная папка не видна обходам и не попадает в план', async () => {
  const dir = await tmpDir();
  await writeFile(dir, 'обычный.txt', '1');
  await writeFile(dir, `${STAGE_DIR}/спрятанный.txt`, '2');

  const dirs = [];
  const files = await scanFiles(dir, '', [], null, null, null, dirs);
  assert.deepStrictEqual(files.map((f) => f.path), ['обычный.txt']);
  assert.deepStrictEqual(dirs, []);
  assert.deepStrictEqual((await listChildren(dir)).items.map((c) => c.name), ['обычный.txt']);
});

// ---- Источник исчезает между планом и применением ----
// Между сканированием и работой проходит время (предпросмотр, кеш сканов),
// и файл на источнике за это время могут удалить. Оригинал на приёмнике при
// этом уже отложен в служебную папку, то есть существует в одном экземпляре.

test('источник исчез перед перезаписью — оригинал на приёмнике остаётся', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await fsp.writeFile(path.join(src, 'отчёт.txt'), 'новое');
  await fsp.writeFile(path.join(dst, 'отчёт.txt'), 'старое');

  const entry = { path: 'отчёт.txt', size: 5, mtimeMs: Date.now() };
  const plan = { copy: [], overwrite: [entry], trash: [], unchanged: [] };

  // Файл пропадает уже после того, как план построен.
  await fsp.rm(path.join(src, 'отчёт.txt'));

  const trashed = [];
  const res = await applyPlan(src, dst, plan, mockTrash(trashed));

  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'отчёт.txt'), 'utf8'),
    'старое',
    'оригинал должен вернуться на место, а не уехать в Корзину'
  );
  assert.deepStrictEqual(res.failures, [{ action: 'overwrite', path: 'отчёт.txt', code: 'ENOENT' }]);
  assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false);
});

test('источник исчез перед копированием — это ошибка, а не тихий пропуск', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();

  const entry = { path: 'новый.txt', size: 3, mtimeMs: Date.now() };
  const plan = { copy: [entry], overwrite: [], trash: [], unchanged: [] };

  const res = await applyPlan(src, dst, plan, mockTrash([]));

  assert.strictEqual(fs.existsSync(path.join(dst, 'новый.txt')), false);
  assert.deepStrictEqual(res.failures, [{ action: 'copy', path: 'новый.txt', code: 'ENOENT' }]);
});

test('источник исчез при запасном пути перемещения — оригинал не пропадает', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await fsp.writeFile(path.join(dst, 'было.txt'), 'данные');
  // Путь назначения занимаем папкой: rename на неё не пройдёт, пойдёт запасной путь.
  await fsp.mkdir(path.join(dst, 'стало.txt'));
  await fsp.writeFile(path.join(dst, 'стало.txt', 'внутри.txt'), 'чужое');

  const plan = {
    copy: [],
    overwrite: [],
    trash: [],
    unchanged: [],
    moves: [{ from: 'было.txt', to: 'стало.txt', path: 'стало.txt', size: 6 }],
  };

  const res = await applyPlan(src, dst, plan, mockTrash([]));

  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'было.txt'), 'utf8'),
    'данные',
    'нечем заменить — значит оригинал остаётся там, где был'
  );
  assert.strictEqual(res.failures.length, 1);
  assert.strictEqual(res.failures[0].code, 'ENOENT');
});

test('restoreStage не уничтожает оригиналы, которые не смог вернуть', async () => {
  const dst = await tmpDir();
  const stage = path.join(dst, STAGE_DIR);
  await fsp.mkdir(stage, { recursive: true });
  await fsp.writeFile(path.join(stage, 'вернётся.txt'), 'первый');
  await fsp.writeFile(path.join(stage, 'застрял.txt'), 'второй');
  // Место возврата занято непустой папкой — rename туда не пройдёт.
  await fsp.mkdir(path.join(dst, 'застрял.txt'));
  await fsp.writeFile(path.join(dst, 'застрял.txt', 'помеха.txt'), 'мешает');

  const restored = await restoreStage(dst);

  assert.strictEqual(restored, 1);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'вернётся.txt'), 'utf8'), 'первый');
  assert.strictEqual(
    await fsp.readFile(path.join(stage, 'застрял.txt'), 'utf8'),
    'второй',
    'служебную папку нельзя сносить, пока внутри лежат чьи-то данные'
  );
});

// ---- Служебная папка: пустые ветки и подсчёт содержимого ----
// Возврат шёл по файлам, а «пусто ли внутри» считалось тем же обходом. Пустых
// папок он не видит: отложенная пустая ветка не возвращалась, а служебная папка
// следом проходила как пустая и уезжала в rm вместе с ней.

test('restoreStage возвращает пустые папки, а не только файлы', async () => {
  const dst = await tmpDir();
  const stage = path.join(dst, STAGE_DIR);
  await writeFile(dst, `${STAGE_DIR}/ветка/файл.txt`, 'данные');
  await fsp.mkdir(path.join(stage, 'ветка', 'пустая'), { recursive: true });

  await restoreStage(dst);

  assert.ok(fs.existsSync(path.join(dst, 'ветка', 'файл.txt')));
  assert.ok(
    fs.existsSync(path.join(dst, 'ветка', 'пустая')),
    'пустая папка — тоже содержимое, её нельзя терять при возврате'
  );
  assert.ok(!fs.existsSync(stage));
});

test('restoreStage возвращает ветку, в которой нет ни одного файла', async () => {
  const dst = await tmpDir();
  await fsp.mkdir(path.join(dst, STAGE_DIR, 'только-папки', 'глубже'), { recursive: true });

  await restoreStage(dst);

  assert.ok(
    fs.existsSync(path.join(dst, 'только-папки', 'глубже')),
    'ветка без файлов считалась пустой служебной папкой и стиралась целиком'
  );
  assert.ok(!fs.existsSync(path.join(dst, STAGE_DIR)));
});

test('restoreStage сливает содержимое, когда место занято папкой', async () => {
  const dst = await tmpDir();
  await writeFile(dst, `${STAGE_DIR}/общая/из-служебной.txt`, 'вернуть');
  await writeFile(dst, 'общая/на-месте.txt', 'уже тут');

  await restoreStage(dst);

  assert.ok(fs.existsSync(path.join(dst, 'общая', 'из-служебной.txt')));
  assert.ok(fs.existsSync(path.join(dst, 'общая', 'на-месте.txt')));
  assert.ok(!fs.existsSync(path.join(dst, STAGE_DIR)));
});

// ---- mkdir не должен уходить на каждый файл ----
// Кеш созданных папок помечал готовность после await, поэтому вся пачка
// параллельных копий успевала проскочить проверку — по сети это лишние
// обращения на каждый файл ветки.

test('копирование пачки файлов в одну папку не гонит mkdir на каждый', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  for (let i = 0; i < 12; i += 1) await writeFile(src, `ветка/ф${i}.txt`, `${i}`);

  const plan = planSync(await scanFiles(src), []);
  const real = fsp.mkdir;
  let calls = 0;
  fsp.mkdir = (...args) => {
    calls += 1;
    return real.apply(fsp, args);
  };
  try {
    await applyPlan(src, dst, plan, mockTrash([]));
  } finally {
    fsp.mkdir = real;
  }

  assert.ok(calls <= 3, `mkdir вызван ${calls} раз на 12 файлов в одной папке`);
  assert.strictEqual((await scanFiles(dst)).length, 12);
});

// ---- Уборка отложенного, когда часть оригиналов застряла ----

test('Корзина отказала — оригиналы остаются в служебной папке, а не пропадают', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'общий.txt', 'останется');
  for (const n of ['a', 'b', 'c']) await writeFile(dst, `лишний-${n}.txt`, 'убрать');
  await writeFile(dst, 'общий.txt', 'останется');

  const plan = planSync(await scanFiles(src), await scanFiles(dst));
  const refuse = async () => {
    throw Object.assign(new Error('занято'), { code: 'EBUSY' });
  };

  const res = await applyPlan(src, dst, plan, refuse);

  assert.strictEqual(res.failures.length, 1, 'об отказе сообщаем ровно один раз');
  assert.strictEqual(res.trashed, 0, 'ничего не выброшено — так и отчитываемся');
  const left = await scanFiles(path.join(dst, STAGE_DIR));
  assert.strictEqual(
    left.length,
    3,
    'единственная копия удаляемых файлов дожидается следующего запуска'
  );
  assert.strictEqual(
    (await restoreStage(dst)) > 0,
    true,
    'и следующий запуск возвращает их на место'
  );
  assert.ok(fs.existsSync(path.join(dst, 'лишний-a.txt')));
});

test('вес вызова Корзины равен числу файлов в служебной папке', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  for (const n of ['a', 'b', 'c']) await writeFile(dst, `лишний-${n}.txt`, 'убрать');

  const plan = planSync(await scanFiles(src), await scanFiles(dst));
  let weight = null;
  await applyPlan(src, dst, plan, async (abs, w) => {
    weight = w;
    await fsp.rm(abs, { recursive: true, force: true });
  });

  assert.strictEqual(
    weight,
    3,
    'служебная папка уезжает одним действием — вызывающий должен знать его вес'
  );
});

// scanFiles намеренно не видит узлов с именем служебной папки — иначе она
// попала бы в план как «лишние файлы». Считать этим же обходом содержимое самой
// служебной папки нельзя: такой файл внутри неё проходил как пустое место,
// и папка стиралась вместе с ним.
test('оригинал с именем служебной папки не пропадает при разборе', async () => {
  const dst = await tmpDir();
  await writeFile(dst, `${STAGE_DIR}/ветка/${STAGE_DIR}`, 'у этого файла особое имя');

  await restoreStage(dst);

  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'ветка', STAGE_DIR), 'utf8'),
    'у этого файла особое имя',
    'файл вернулся на место, а не уехал в rm вместе со служебной папкой'
  );
});

test('служебная папка уцелеет, пока внутри лежит невозвратимый оригинал', async () => {
  const dst = await tmpDir();
  // Место возврата занято непустой папкой — файл туда не вернуть. Имя у файла
  // при этом такое же, как у служебной папки, то есть обход по файлам его
  // не увидит: раньше служебная папка проходила как пустая и стиралась.
  await writeFile(dst, `ветка/${STAGE_DIR}/помеха.txt`, 'занимает место');
  await writeFile(dst, `${STAGE_DIR}/ветка/${STAGE_DIR}`, 'единственная копия');

  await restoreStage(dst);

  assert.strictEqual(
    await fsp.readFile(path.join(dst, STAGE_DIR, 'ветка', STAGE_DIR), 'utf8'),
    'единственная копия',
    'невозвращённый оригинал обязан дождаться следующего запуска'
  );
});

// Возврат идёт целыми узлами, поэтому оригинал становится на место даже тогда,
// когда его позицию успел занять оборвавшийся запуск.
test('оригинал возвращается поверх того, что занял его место', async () => {
  const dst = await tmpDir();
  await writeFile(dst, 'занято', 'помеха от оборванного запуска');
  await writeFile(dst, `${STAGE_DIR}/занято/внутри.txt`, 'единственная копия');

  await restoreStage(dst);

  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'занято', 'внутри.txt'), 'utf8'),
    'единственная копия'
  );
  assert.ok(!fs.existsSync(path.join(dst, STAGE_DIR)));
});
