'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { buildRunPlan, countByFolder, ancestorsOf } = require('../src/plan');
const { scanFiles, applyPlan, STAGE_DIR } = require('../src/fsops');

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
