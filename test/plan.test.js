'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { buildRunPlan, countByFolder, ancestorsOf, scanFromIndex } = require('../src/plan');
const { scanFiles, applyPlan, STAGE_DIR } = require('../src/fsops');
const { summarize } = require('../src/sync');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-plan-'));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

// Живой сканер — такой же, каким main.js кормит планировщик, но без кеша и обхода.
function branchExcludes(excludes, folder) {
  const set = new Set();
  for (const ex of excludes) {
    if (ex.startsWith(folder + '/')) set.add(ex.slice(folder.length + 1));
  }
  return set;
}

const liveScan = async (root, branch, excludes) => {
  const dirs = [];
  const files = await scanFiles(
    path.join(root, branch),
    '',
    [],
    branchExcludes(excludes || [], branch),
    null,
    null,
    dirs
  );
  return { files, dirs };
};

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

const mockTrash = async (abs) => fsp.rm(abs, { recursive: true, force: true });

test('ancestorsOf разбирает цепочку родителей', () => {
  assert.deepStrictEqual(ancestorsOf('a/b/c'), ['a', 'a/b']);
  assert.deepStrictEqual(ancestorsOf('одна'), []);
});

test('перенос между двумя выбранными ветками виден как перемещение', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'Документы/отчёт.pdf', 'содержимое отчёта');
  await fsp.mkdir(path.join(src, 'Архив'), { recursive: true });
  await fsp.cp(src, dst, { recursive: true });
  await fsp.rename(path.join(src, 'Документы/отчёт.pdf'), path.join(src, 'Архив/отчёт.pdf'));

  const folders = ['Документы', 'Архив'];
  const plan = await buildRunPlan(src, dst, folders, [], liveScan);

  assert.strictEqual(plan.moves.length, 1);
  assert.strictEqual(plan.moves[0].from, 'Документы/отчёт.pdf');
  assert.strictEqual(plan.moves[0].to, 'Архив/отчёт.pdf');
  assert.strictEqual(plan.copy.length, 0);
  assert.strictEqual(plan.trash.length, 0);

  await applyPlan(src, dst, plan, mockTrash);
  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
});

test('невыбранная ветка не трогается, даже если файл ушёл туда', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'Выбрано/файл.txt', 'данные');
  await writeFile(src, 'Мимо/сосед.txt', 'не трогать');
  await fsp.cp(src, dst, { recursive: true });
  await fsp.rm(path.join(src, 'Выбрано/файл.txt'));

  const plan = await buildRunPlan(src, dst, ['Выбрано'], [], liveScan);
  assert.strictEqual(plan.moves.length, 0);
  assert.strictEqual(plan.trash.length, 1);

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'Мимо/сосед.txt'), 'utf8'), 'не трогать');
  assert.strictEqual(fs.existsSync(path.join(dst, 'Выбрано/файл.txt')), false);
});

test('вложенная ветка создаётся вместе с родителями', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'год/2026/квартал/итог.txt', 'цифры');

  const plan = await buildRunPlan(src, dst, ['год/2026'], [], liveScan);
  assert.ok(plan.dirs.create.includes('год'));
  assert.ok(plan.dirs.create.includes('год/2026'));

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'год/2026/квартал/итог.txt'), 'utf8'), 'цифры');
});

test('исключённая ветка не попадает ни в файлы, ни в папки', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'docs/2023/a.txt', 'a');
  await writeFile(dst, 'docs/2024/личное.txt', 'приватное');
  await fsp.mkdir(path.join(dst, 'docs/2024/глубже'), { recursive: true });

  const plan = await buildRunPlan(src, dst, ['docs'], ['docs/2024'], liveScan);
  const touched = [
    ...plan.copy.map((e) => e.path),
    ...plan.trash.map((e) => e.path),
    ...plan.dirs.create,
    ...plan.dirs.remove,
  ];
  assert.ok(!touched.some((p) => p.startsWith('docs/2024')));

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'docs/2024/личное.txt'), 'utf8'), 'приватное');
});

test('после синхронизации деревья совпадают полностью, повтор не находит работы', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();

  await writeFile(src, 'Проект/код/main.js', 'console.log(1)');
  await writeFile(src, 'Проект/док/readme.md', '# привет');
  await fsp.mkdir(path.join(src, 'Проект/пусто'), { recursive: true });
  await writeFile(dst, 'Проект/старое/мусор.tmp', 'x');
  await writeFile(dst, 'Проект/док/readme.md', 'старая версия');

  const plan = await buildRunPlan(src, dst, ['Проект'], [], liveScan);
  const res = await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(res.failures.length, 0);

  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
  assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false);

  const again = await buildRunPlan(src, dst, ['Проект'], [], liveScan);
  assert.strictEqual(again.moves.length, 0);
  assert.strictEqual(again.copy.length, 0);
  assert.strictEqual(again.overwrite.length, 0);
  assert.strictEqual(again.trash.length, 0);
  assert.strictEqual(again.dirs.create.length, 0);
  assert.strictEqual(again.dirs.remove.length, 0);
});

test('выбран отдельный файл, а не папка', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'заметки.txt', 'новое');
  await writeFile(dst, 'заметки.txt', 'старое');
  await writeFile(dst, 'другое.txt', 'не трогать');

  const plan = await buildRunPlan(src, dst, ['заметки.txt'], [], liveScan);
  assert.strictEqual(plan.overwrite.length, 1);
  assert.strictEqual(plan.dirs.remove.length, 0);

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'заметки.txt'), 'utf8'), 'новое');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'другое.txt'), 'utf8'), 'не трогать');
});

test('countByFolder раскладывает работу по веткам и сходится с общим итогом', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'A/новый.txt', '1');
  await writeFile(src, 'B/тоже.txt', '2');
  await writeFile(dst, 'B/лишний.txt', '3');

  const folders = ['A', 'B'];
  const plan = await buildRunPlan(src, dst, folders, [], liveScan);
  const byFolder = countByFolder(plan, folders);
  const sum = (key) => byFolder.reduce((n, pf) => n + pf.summary[key], 0);

  assert.strictEqual(sum('copy'), plan.copy.length);
  assert.strictEqual(sum('trash'), plan.trash.length);
  assert.strictEqual(sum('dirs'), plan.dirs.create.length + plan.dirs.remove.length);
});

test('родительская папка ветки не удаляется, если на источнике она есть', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  // 'Документы' есть на обеих сторонах, а вот 'Документы/2024' — только на приёмнике.
  await fsp.mkdir(path.join(src, 'Документы'), { recursive: true });
  await writeFile(dst, 'Документы/2024/старое.txt', 'выкинуть');

  const plan = await buildRunPlan(src, dst, ['Документы/2024'], [], liveScan);

  assert.ok(
    plan.dirs.remove.includes('Документы/2024'),
    'саму лишнюю ветку убрать надо'
  );
  assert.ok(
    !plan.dirs.remove.includes('Документы'),
    'а её родителя — нет: на источнике эта папка живая'
  );

  await applyPlan(src, dst, plan, async (abs) => fsp.rm(abs, { recursive: true, force: true }));
  assert.strictEqual(fs.existsSync(path.join(dst, 'Документы')), true);
  assert.strictEqual(fs.existsSync(path.join(dst, 'Документы', '2024')), false);
});

test('родительская папка создаётся, когда её нет на приёмнике', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'Документы/2024/новое.txt', 'копировать');

  const plan = await buildRunPlan(src, dst, ['Документы/2024'], [], liveScan);
  await applyPlan(src, dst, plan, async (abs) => fsp.rm(abs, { recursive: true, force: true }));

  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'Документы', '2024', 'новое.txt'), 'utf8'),
    'копировать'
  );
});

test('ложный перенос по размеру и дате не подменяет содержимое на приёмнике', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'новое/данные.bin', 'AAAA');
  await writeFile(dst, 'старое/архив.bin', 'BBBB'); // тот же размер, чужое содержимое
  const stamp = new Date(1700000000000);
  await fsp.utimes(path.join(src, 'новое/данные.bin'), stamp, stamp);
  await fsp.utimes(path.join(dst, 'старое/архив.bin'), stamp, stamp);

  const plan = await buildRunPlan(src, dst, ['новое', 'старое'], [], liveScan);
  assert.strictEqual(plan.moves.length, 0);

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'новое/данные.bin'), 'utf8'), 'AAAA');
  assert.strictEqual(fs.existsSync(path.join(dst, 'старое/архив.bin')), false);
});

test('на источнике папка, на приёмнике файл с тем же именем', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'отчёты/май.txt', 'данные');
  await writeFile(dst, 'отчёты', 'а тут был файл');

  const plan = await buildRunPlan(src, dst, ['отчёты'], [], liveScan);
  assert.deepStrictEqual(plan.conflicts, ['отчёты']);

  const res = await applyPlan(src, dst, plan, mockTrash);
  assert.deepStrictEqual(res.failures, []);
  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
});

test('на источнике файл, на приёмнике папка с тем же именем', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'отчёты', 'теперь это файл');
  await writeFile(dst, 'отчёты/май.txt', 'старые данные');

  const plan = await buildRunPlan(src, dst, ['отчёты'], [], liveScan);
  assert.deepStrictEqual(plan.conflicts, ['отчёты']);

  const res = await applyPlan(src, dst, plan, mockTrash);
  assert.deepStrictEqual(res.failures, []);
  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
  assert.strictEqual(await fsp.readFile(path.join(dst, 'отчёты'), 'utf8'), 'теперь это файл');
});

test('остановка на конфликте типов возвращает приёмник как было', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'узел/файл.txt', 'новое');
  await writeFile(dst, 'узел', 'исходный файл');
  const before = await treeOf(dst);

  const plan = await buildRunPlan(src, dst, ['узел'], [], liveScan);
  const res = await applyPlan(src, dst, plan, mockTrash, () => {}, { shouldStop: () => true });

  assert.strictEqual(res.cancelled, true);
  assert.deepStrictEqual(await treeOf(dst), before);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'узел'), 'utf8'), 'исходный файл');
});

test('вложенная ветка получает свои счётчики, а не отдаёт их родителю', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'док/верх.txt', 'В');
  await writeFile(src, 'док/скрытое/мимо.txt', 'М');
  await writeFile(src, 'док/скрытое/нужное/глубоко.txt', 'Г');

  // Отмечено 'док', снята отметка с 'док/скрытое', возвращена 'док/скрытое/нужное'.
  const folders = ['док', 'док/скрытое/нужное'];
  const plan = await buildRunPlan(src, dst, folders, ['док/скрытое'], liveScan);
  const per = countByFolder(plan, folders);
  const by = Object.fromEntries(per.map((p) => [p.folder, p.summary]));

  assert.strictEqual(by['док'].copy, 1);
  assert.strictEqual(by['док/скрытое/нужное'].copy, 1);

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(fs.existsSync(path.join(dst, 'док/скрытое/мимо.txt')), false);
  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'док/скрытое/нужное/глубоко.txt'), 'utf8'),
    'Г'
  );
});

test('конфликт типов в глубине ветки разбирается за один запуск', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  // 'док/узел' — папка на источнике и файл на приёмнике.
  await writeFile(src, 'док/узел/внутри.txt', 'новое');
  await writeFile(dst, 'док/узел', 'а тут был файл');
  // 'док/второй' — наоборот: файл на источнике, папка на приёмнике.
  await writeFile(src, 'док/второй', 'файл');
  await writeFile(dst, 'док/второй/старое.txt', 'мусор');

  const plan = await buildRunPlan(src, dst, ['док'], [], liveScan);
  assert.deepStrictEqual([...plan.conflicts].sort(), ['док/второй', 'док/узел']);

  const res = await applyPlan(src, dst, plan, mockTrash);
  assert.deepStrictEqual(res.failures, []);
  assert.deepStrictEqual(await treeOf(dst), await treeOf(src));
  assert.strictEqual(await fsp.readFile(path.join(dst, 'док/узел/внутри.txt'), 'utf8'), 'новое');
  assert.strictEqual(await fsp.readFile(path.join(dst, 'док/второй'), 'utf8'), 'файл');

  // Повтор не находит работы — приёмник действительно приведён в порядок.
  const again = await buildRunPlan(src, dst, ['док'], [], liveScan);
  assert.strictEqual(summarize(again).total, 0);
});

test('остановка на глубоком конфликте возвращает приёмник как было', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'док/узел/внутри.txt', 'новое');
  await writeFile(dst, 'док/узел', 'исходный файл');
  await writeFile(dst, 'док/сосед.txt', 'не трогать');
  const before = await treeOf(dst);

  const plan = await buildRunPlan(src, dst, ['док'], [], liveScan);
  const res = await applyPlan(src, dst, plan, mockTrash, () => {}, { shouldStop: () => true });

  assert.strictEqual(res.cancelled, true);
  assert.deepStrictEqual(await treeOf(dst), before);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'док/узел'), 'utf8'), 'исходный файл');
});

// ---- Скан из индекса фонового обхода ----
// main.js строит план либо живым сканом, либо по индексу завершённого обхода.
// Источники разные, а план обязан выходить один и тот же.

const { crawlTree } = require('../src/fsops');

// Собирает индекс стороны ровно так же, как это делает обработчик start-crawl.
async function indexOf(root) {
  const files = new Map();
  const dirs = new Set();
  await crawlTree(root, '', (rel, isDir, size, cnt, mtimeMs) => {
    if (isDir) dirs.add(rel);
    else files.set(rel, { size, mtimeMs });
  });
  return { files, dirs };
}

// Сканер поверх индексов — подмена liveScan в тестах.
function indexScan(srcRoot, srcIdx, dstRoot, dstIdx) {
  return (root, branch, excludes) =>
    scanFromIndex(root === srcRoot ? srcIdx : dstIdx, branch, excludes || []);
}

test('scanFromIndex: исключение действует только внутри своей ветки', () => {
  const idx = {
    files: new Map([
      ['док/сам.txt', { size: 1, mtimeMs: 0 }],
      ['док/а/пропустить.txt', { size: 1, mtimeMs: 0 }],
      ['док/а/б/вернули.txt', { size: 1, mtimeMs: 0 }],
    ]),
    dirs: new Set(['док', 'док/а', 'док/а/б']),
  };

  // Для ветки 'док' запрет 'док/а' действует и накрывает всё вложенное.
  const верх = scanFromIndex(idx, 'док', ['док/а']);
  assert.deepStrictEqual(верх.files.map((f) => f.path), ['сам.txt']);
  assert.deepStrictEqual(верх.dirs, []);

  // Для ветки 'док/а/б' тот же запрет уже не действует: отметка точнее.
  const низ = scanFromIndex(idx, 'док/а/б', ['док/а']);
  assert.deepStrictEqual(низ.files.map((f) => f.path), ['вернули.txt']);
});

test('scanFromIndex совпадает с живым сканом на возвращённой вложенной ветке', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'док/сам.txt', 'один');
  await writeFile(src, 'док/а/пропустить.txt', 'мимо');
  await writeFile(src, 'док/а/б/вернули.txt', 'нужен');

  const folders = ['док', 'док/а/б'];
  const excludes = ['док/а'];

  const byScan = await buildRunPlan(src, dst, folders, excludes, liveScan);
  const byIndex = await buildRunPlan(
    src,
    dst,
    folders,
    excludes,
    indexScan(src, await indexOf(src), dst, await indexOf(dst))
  );

  const paths = (plan) => plan.copy.map((e) => e.path).sort();
  assert.deepStrictEqual(paths(byIndex), paths(byScan));
  assert.deepStrictEqual(paths(byIndex), ['док/а/б/вернули.txt', 'док/сам.txt']);
  assert.deepStrictEqual(summarize(byIndex), summarize(byScan));
});

test('план по индексу и по живому скану сходится на дереве с переносом и удалением', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'док/новый.txt', 'новый');
  await writeFile(src, 'док/глубже/переехал.txt', 'тело');
  await writeFile(src, 'док/общий.txt', 'одинаково');
  await writeFile(dst, 'док/переехал.txt', 'тело');
  await writeFile(dst, 'док/общий.txt', 'одинаково');
  await writeFile(dst, 'док/лишний.txt', 'убрать');
  // Даты должны совпасть, иначе перенос не распознается.
  const when = new Date(2020, 0, 1);
  for (const [root, rel] of [[src, 'док/глубже/переехал.txt'], [dst, 'док/переехал.txt']]) {
    await fsp.utimes(path.join(root, rel), when, when);
  }
  for (const root of [src, dst]) await fsp.utimes(path.join(root, 'док/общий.txt'), when, when);

  const byScan = await buildRunPlan(src, dst, ['док'], [], liveScan);
  const byIndex = await buildRunPlan(
    src,
    dst,
    ['док'],
    [],
    indexScan(src, await indexOf(src), dst, await indexOf(dst))
  );

  assert.deepStrictEqual(summarize(byIndex), summarize(byScan));
  assert.strictEqual(byIndex.moves.length, 1);
  assert.deepStrictEqual(byIndex.dirs, byScan.dirs);
  assert.deepStrictEqual(
    byIndex.trash.map((e) => e.path),
    ['док/лишний.txt']
  );
});

// ---- Регистр в путях ----

test('переименование одного регистра не стирает файл с приёмника', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'док/Заметка.txt', 'тело');
  await writeFile(dst, 'док/заметка.txt', 'тело');

  const plan = await buildRunPlan(src, dst, ['док'], [], liveScan);
  await applyPlan(src, dst, plan, mockTrash);

  // Файл на месте и с прежним содержимым, а не унесён в Корзину вслед за копией.
  assert.deepStrictEqual(await treeOf(dst), ['док/', 'док/Заметка.txt']);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'док/Заметка.txt'), 'utf8'), 'тело');

  // Повтор пуст: сторонам больше нечего выяснять.
  const again = await buildRunPlan(src, dst, ['док'], [], liveScan);
  assert.strictEqual(summarize(again).total, 0);
});

test('ветка, написанная в регистре другой стороны, не выглядит пустой в индексе', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'док/а.txt', 'тело');
  await writeFile(src, 'док/б.txt', 'тело2');
  await writeFile(dst, 'Док/а.txt', 'тело');
  await writeFile(dst, 'Док/б.txt', 'тело2');
  const when = new Date(2020, 0, 1);
  for (const [root, rel] of [[src, 'док/а.txt'], [dst, 'Док/а.txt'], [src, 'док/б.txt'], [dst, 'Док/б.txt']]) {
    await fsp.utimes(path.join(root, rel), when, when);
  }

  // Интерфейс отдаёт ветку с написанием той стороны, что попала в список первой.
  const plan = await buildRunPlan(
    src,
    dst,
    ['Док'],
    [],
    indexScan(src, await indexOf(src), dst, await indexOf(dst))
  );

  // Раньше источник читался пустым, и весь приёмник уходил в удаление.
  assert.deepStrictEqual(plan.trash.map((e) => e.path), []);
  assert.deepStrictEqual(plan.dirs.remove, []);
});

test('scanFromIndex находит ветку независимо от регистра', () => {
  const idx = {
    files: new Map([['Док/а.txt', { size: 1, mtimeMs: 0 }], ['Док/вложено/б.txt', { size: 2, mtimeMs: 0 }]]),
    dirs: new Set(['Док', 'Док/вложено']),
  };
  const got = scanFromIndex(idx, 'док', ['док/вложено']);
  assert.deepStrictEqual(got.files.map((e) => e.path), ['а.txt']);
  assert.deepStrictEqual(got.dirs, []);
});

// Папки-родители выбранной ветки план создаёт, но внутрь ветки они не вложены.
// В шапке предпросмотра они были, в строке по ветке — нет, и сумма по строкам
// не сходилась с итогом.
test('счётчик ветки учитывает её собственных родителей', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'год/квартал/неделя/отчёт.txt', 'данные');

  const plan = await buildRunPlan(src, dst, ['год/квартал/неделя'], [], liveScan);
  const totals = summarize(plan);
  const [row] = countByFolder(plan, ['год/квартал/неделя']);

  assert.deepStrictEqual(plan.dirs.create, ['год', 'год/квартал', 'год/квартал/неделя']);
  assert.strictEqual(row.summary.dirs, totals.dirs);
  assert.strictEqual(row.summary.total, totals.total);
});

// ---- Кандидаты в перемещения ----

// Имя, размер и дата сходились у двух совершенно разных файлов, и приёмник
// переименовывал свой старый файл в новый путь: на месте нового оказывалось
// чужое содержимое. Следующий запуск разницы уже не видел — имя, размер и дата
// сходятся, — и порча оставалась навсегда.
test('одинаковые имя, размер и дата, но разное содержимое — это не перемещение', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  const when = new Date(2020, 0, 1);
  await writeFile(src, 'д/новая/config.json', 'AAAAA');
  await writeFile(dst, 'д/старая/config.json', 'BBBBB');
  await fsp.utimes(path.join(src, 'д/новая/config.json'), when, when);
  await fsp.utimes(path.join(dst, 'д/старая/config.json'), when, when);

  const plan = await buildRunPlan(src, dst, ['д'], [], liveScan);
  assert.strictEqual(plan.moves.length, 0, 'пара по метаданным обязана отсеяться сверкой');
  assert.deepStrictEqual(plan.copy.map((e) => e.path), ['д/новая/config.json']);
  assert.deepStrictEqual(plan.trash.map((e) => e.path), ['д/старая/config.json']);

  await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(
    await fsp.readFile(path.join(dst, 'д/новая/config.json'), 'utf8'),
    'AAAAA',
    'приёмник получил содержимое чужого файла'
  );
});

test('настоящее перемещение по-прежнему обходится переименованием', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'д/старая/отчёт.pdf', 'x'.repeat(200000));
  await fsp.cp(src, dst, { recursive: true });
  await fsp.mkdir(path.join(src, 'д/новая'), { recursive: true });
  await fsp.rename(path.join(src, 'д/старая/отчёт.pdf'), path.join(src, 'д/новая/отчёт.pdf'));

  const plan = await buildRunPlan(src, dst, ['д'], [], liveScan);
  assert.strictEqual(plan.moves.length, 1);
  assert.strictEqual(plan.copy.length, 0);
  assert.strictEqual(plan.trash.length, 0);
});

// ---- Конфликт типа в предке ветки ----

// Внутрь файла не проходит ничего: mkdir отвечает EEXIST, копирование — ENOTDIR.
// Ветка не синхронизировалась никогда, и каждый запуск заканчивался одними
// и теми же ошибками с путями, которых на приёмнике вообще нет.
test('предок выбранной ветки — файл на приёмнике: узел убирается, ветка доезжает', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'a/b/нужный.txt', 'нужен');
  await writeFile(dst, 'a', 'на приёмнике это файл');

  const plan = await buildRunPlan(src, dst, ['a/b'], [], liveScan);
  assert.deepStrictEqual(plan.conflicts, ['a']);

  const res = await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(res.failures.length, 0);
  assert.deepStrictEqual(await treeOf(dst), ['a/', 'a/b/', 'a/b/нужный.txt']);
});

test('общий конфликтный предок двух веток убирается один раз', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'a/b/один.txt', '1');
  await writeFile(src, 'a/c/два.txt', '2');
  await writeFile(dst, 'a', 'на приёмнике это файл');

  const plan = await buildRunPlan(src, dst, ['a/b', 'a/c'], [], liveScan);
  assert.deepStrictEqual(plan.conflicts, ['a'], 'повтор увёл бы отчёт в «удалено безвозвратно»');

  const res = await applyPlan(src, dst, plan, mockTrash);
  assert.strictEqual(res.failures.length, 0);
  assert.strictEqual(res.unrecoverable, 0);
  assert.deepStrictEqual(await treeOf(dst), ['a/', 'a/b/', 'a/b/один.txt', 'a/c/', 'a/c/два.txt']);
});

test('остановка возвращает на место файл, снятый конфликтом в предке', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'a/b/нужный.txt', 'нужен');
  await writeFile(dst, 'a', 'на приёмнике это файл');
  const before = await treeOf(dst);

  const plan = await buildRunPlan(src, dst, ['a/b'], [], liveScan);
  let steps = 0;
  const res = await applyPlan(src, dst, plan, mockTrash, () => { steps += 1; }, {
    shouldStop: () => steps >= 2,
  });

  assert.strictEqual(res.cancelled, true);
  assert.deepStrictEqual(await treeOf(dst), before);
  assert.strictEqual(await fsp.readFile(path.join(dst, 'a'), 'utf8'), 'на приёмнике это файл');
  assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false);
});
