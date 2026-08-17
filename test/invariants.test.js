'use strict';

// Дифференциальные прогоны на случайных деревьях: не «проверить сценарий»,
// а «сформулировать закон и попробовать его сломать».
//
// Эти прогоны написаны 17.08.2026 при полной ревизии и тогда же нашли ноль
// расхождений в ядре синхронизации — все дефекты той сессии лежали по краям
// (права на папку, пределы роста истории, опознание узлов дерева). Ноль — это
// и есть их ценность: пока они зелёные, ядро не деградировало, и следующей
// ревизии не нужно перепроверять его руками. Ради этого они и лежат в репозитории,
// а не в черновиках, как было раньше.
//
// Генератор псевдослучайный и засеян числом: набор деревьев один и тот же
// от запуска к запуску. Порядок файловых операций внутри пула при этом не
// фиксирован, поэтому редкое падение может не повториться дословно — но само
// нарушение закона от этого не перестаёт быть настоящим багом.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { buildRunPlan, scanFromIndex, countByFolder } = require('../src/plan');
const { summarize } = require('../src/sync');
const { scanFiles, crawlTree, applyPlan, restoreStage, STAGE_DIR } = require('../src/fsops');

// ---- Генератор ----
let seed = 1;
const setSeed = (n) => { seed = n; };
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
// Имена нарочно пересекаются по регистру ('Doc'/'doc', 'sub'/'Sub') и один и тот же
// набор годится и для папки, и для файла: так рождаются и конфликты типов,
// и пары, различающиеся только написанием.
const NAMES = ['a', 'b', 'c', 'Doc', 'doc', 'x.txt', 'y.txt', 'Z.txt', 'sub', 'Sub'];

async function makeTree(root, depth = 0) {
  const n = Math.floor(rnd() * 4);
  for (let i = 0; i < n; i += 1) {
    const name = pick(NAMES);
    const p = path.join(root, name);
    const isDir = depth < 3 && rnd() < 0.45;
    try {
      if (isDir) {
        await fsp.mkdir(p, { recursive: true });
        await makeTree(p, depth + 1);
      } else {
        await fsp.writeFile(p, 'c'.repeat(Math.floor(rnd() * 40)) + name);
      }
    } catch {
      // имя уже занято узлом другого типа — это тоже часть случая
    }
  }
}

// Снимок дерева: путь без учёта регистра → содержимое файла или '/' для папки.
async function snap(root, rel = '', out = new Map()) {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (d.name === STAGE_DIR) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.set(r.toLowerCase(), '/');
      await snap(root, r, out);
    } else {
      out.set(r.toLowerCase(), await fsp.readFile(path.join(root, r), 'utf8'));
    }
  }
  return out;
}

function diffOf(want, got) {
  const out = [];
  for (const [k, v] of want) if (got.get(k) !== v) out.push(`${k}: ждали ${JSON.stringify(v)}, лежит ${JSON.stringify(got.get(k))}`);
  for (const k of got.keys()) if (!want.has(k)) out.push(`лишнее: ${k}`);
  return out;
}

// Сканер в том же виде, в каком его собирает main.js: исключения приходят
// от корня стороны, а скану нужны относительно ветки.
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

const rmTrash = async (p) => fsp.rm(p, { recursive: true, force: true });

// Две случайные стороны и список веток верхнего уровня с обеих.
async function build(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await fsp.mkdir(src);
  await fsp.mkdir(dst);
  await makeTree(src);
  await makeTree(dst);
  const names = new Set();
  for (const r of [src, dst]) for (const d of await fsp.readdir(r)) names.add(d);
  return { src, dst, folders: [...names] };
}

// Пути источника, годные в исключения.
async function allPaths(root, rel = '', out = []) {
  let ds;
  try {
    ds = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of ds) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    out.push(r);
    if (d.isDirectory()) await allPaths(root, r, out);
  }
  return out;
}

test('приёмник становится точной копией источника', async (t) => {
  for (let i = 1; i <= 40; i += 1) {
    setSeed(i * 7919);
    const { src, dst, folders } = await build(t);
    if (!folders.length) continue;

    const plan = await buildRunPlan(src, dst, folders, [], scanner);
    const res = await applyPlan(src, dst, plan, rmTrash);

    const diff = diffOf(await snap(src), await snap(dst));
    assert.deepStrictEqual(res.failures, [], `прогон ${i}: ошибки на ровном месте`);
    assert.deepStrictEqual(diff, [], `прогон ${i}: стороны разошлись`);
    const left = await fsp.readdir(path.join(dst, STAGE_DIR)).catch(() => []);
    assert.deepStrictEqual(left, [], `прогон ${i}: служебная папка не убрана`);
  }
});

test('второй прогон не находит работы (идемпотентность), в том числе с исключениями', async (t) => {
  for (let i = 1; i <= 40; i += 1) {
    setSeed(i * 7919 + 13);
    const { src, dst, folders } = await build(t);
    if (!folders.length) continue;
    const excludes = (await allPaths(src)).filter(() => rnd() < 0.12);

    const first = await buildRunPlan(src, dst, folders, excludes, scanner);
    await applyPlan(src, dst, first, rmTrash);
    const second = await buildRunPlan(src, dst, folders, excludes, scanner);

    assert.strictEqual(
      summarize(second).total,
      0,
      `прогон ${i}: повтор нашёл работу (исключения: ${excludes.join(',') || '—'})`
    );
  }
});

test('остановка в любой точке возвращает приёмник ровно в исходное состояние', async (t) => {
  for (let i = 1; i <= 40; i += 1) {
    setSeed(i * 104729 + 5);
    const { src, dst, folders } = await build(t);
    if (!folders.length) continue;

    const before = await snap(dst);
    const plan = await buildRunPlan(src, dst, folders, [], scanner);
    const total = summarize(plan).total;
    if (total === 0) continue;

    const stopAt = Math.floor(rnd() * total);
    let done = 0;
    const res = await applyPlan(src, dst, plan, rmTrash, () => { done += 1; }, {
      shouldStop: () => done >= stopAt,
    });
    if (!res.cancelled) continue;

    // Сверяем сразу, без restoreStage. Разбор служебной папки на старте следующего
    // запуска — страховка на случай вылета, и подмешивать её сюда нельзя: она
    // вернула бы то, что не вернул откат, и сломанный откат прошёл бы незамеченным.
    // Проверено мутацией: с вырезанным возвратом отложенных оригиналов тест падает.
    const diff = diffOf(before, await snap(dst));
    assert.deepStrictEqual(diff, [], `прогон ${i}: остановка на ${stopAt}/${total} не вернула приёмник`);
    assert.strictEqual(
      fs.existsSync(path.join(dst, STAGE_DIR)),
      false,
      `прогон ${i}: после отката осталась служебная папка`
    );
  }
});

// Шестой закон. Пять предыдущих строят две независимые случайные стороны, и
// пересечение у них слабое: почти всё оказывается «скопировать» и «в Корзину»,
// а пары, различающиеся только написанием пути, встречаются едва-едва. Здесь
// приёмник — искажённая копия источника, поэтому в план массово попадают
// перезаписи, конфликты типов и папки, написанные иначе. Именно так и нашлась
// вечная перезапись: файл в папке, написанной на приёмнике другим регистром,
// уходил в перезапись на каждом запуске — предпросмотр обещал работу, работа
// выполнялась, следующий предпросмотр обещал ровно ту же.
//
// Дерево тут гуще, чем у общего makeTree: закон держится на папках, написанных
// на приёмнике иначе, а редкая папка на редкий шанс перевернуть написание давала
// на все сорок прогонов пять таких случаев — мутацией проверено, что этого мало,
// и с внесённым обратно багом прогон оставался зелёным.
async function makeDenseTree(root, depth = 0) {
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i += 1) {
    const name = pick(NAMES) + i;
    const p = path.join(root, name);
    try {
      if (depth < 3 && rnd() < 0.55) {
        await fsp.mkdir(p, { recursive: true });
        await makeDenseTree(p, depth + 1);
      } else {
        await fsp.writeFile(p, 'c'.repeat(Math.floor(rnd() * 40)) + name);
      }
    } catch {
      // имя уже занято узлом другого типа — это тоже часть случая
    }
  }
}

async function perturbedCopy(src, dst, rel = '') {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(src, rel), { withFileTypes: true });
  } catch {
    return;
  }
  await fsp.mkdir(path.join(dst, rel), { recursive: true });
  for (const d of dirents) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    const roll = rnd();
    try {
      if (roll < 0.08) continue; // на приёмнике этого узла нет
      if (d.isDirectory()) {
        if (roll < 0.13) {
          await fsp.writeFile(path.join(dst, r), 'на приёмнике это файл');
          continue;
        }
        // Написание папки расходится со стороной-источником. Дальше в неё пишем
        // по имени источника: для Windows это та же самая папка, и написание
        // приёмника так и остаётся — ровно как в жизни.
        const name = roll < 0.5 ? d.name.toUpperCase() : d.name;
        await fsp.mkdir(path.join(dst, rel ? `${rel}/${name}` : name), { recursive: true });
        await perturbedCopy(src, dst, r);
      } else {
        if (roll < 0.13) {
          await fsp.mkdir(path.join(dst, r), { recursive: true });
          continue;
        }
        const body = await fsp.readFile(path.join(src, r), 'utf8');
        await fsp.writeFile(path.join(dst, r), roll < 0.3 ? body + '!' : body);
      }
    } catch {
      // имя уже занято узлом другого типа — это тоже часть случая
    }
  }
}

test('предпросмотр не врёт: сумма по веткам сходится, а повтор пуст', async (t) => {
  for (let i = 1; i <= 40; i += 1) {
    setSeed(i * 7919 + 57);
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await fsp.mkdir(src);
    await fsp.mkdir(dst);
    await makeDenseTree(src);
    await perturbedCopy(src, dst);

    const folders = await fsp.readdir(src);
    if (!folders.length) continue;
    const excludes = (await allPaths(src)).filter((p) => p.includes('/') && rnd() < 0.12);

    const plan = await buildRunPlan(src, dst, folders, excludes, scanner);
    const totals = summarize(plan);
    const perFolder = countByFolder(plan, folders);
    const sum = perFolder.reduce((n, pf) => n + pf.summary.total, 0);
    assert.strictEqual(
      sum,
      totals.total,
      `прогон ${i}: сумма по веткам ${sum} != итог ${totals.total} (ветки: ${folders.join(',')})`
    );

    const res = await applyPlan(src, dst, plan, rmTrash);
    assert.deepStrictEqual(res.failures, [], `прогон ${i}: ошибки на ровном месте`);

    const again = await buildRunPlan(src, dst, folders, excludes, scanner);
    assert.strictEqual(
      summarize(again).total,
      0,
      `прогон ${i}: повтор нашёл работу (исключения: ${excludes.join(',') || '—'})`
    );
  }
});

test('план по индексу обхода совпадает с планом по живому скану', async (t) => {
  // Два независимых источника данных для одного и того же решения. Разойдись
  // они — один и тот же выбор давал бы разный результат в зависимости от того,
  // включён ли подсчёт размеров, а такую разницу пользователю не объяснить.
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
  const shape = (p) => JSON.stringify({
    copy: p.copy.map((e) => e.path.toLowerCase()).sort(),
    overwrite: p.overwrite.map((e) => e.path.toLowerCase()).sort(),
    trash: p.trash.map((e) => e.path.toLowerCase()).sort(),
    moves: p.moves.map((m) => `${m.from}→${m.to}`.toLowerCase()).sort(),
    create: p.dirs.create.map((d) => d.toLowerCase()).sort(),
    remove: p.dirs.remove.map((d) => d.toLowerCase()).sort(),
    conflicts: p.conflicts.map((c) => c.toLowerCase()).sort(),
    skipped: p.skipped.map((c) => c.toLowerCase()).sort(),
  });

  for (let i = 1; i <= 40; i += 1) {
    setSeed(i * 7919 + 31);
    const { src, dst, folders } = await build(t);
    if (!folders.length) continue;
    const excludes = (await allPaths(src)).filter(() => rnd() < 0.15);

    const idx = { [src]: await indexOf(src), [dst]: await indexOf(dst) };
    const byIndex = (root, branch, ex) => scanFromIndex(idx[root], branch, ex);

    const live = await buildRunPlan(src, dst, folders, excludes, scanner);
    const indexed = await buildRunPlan(src, dst, folders, excludes, byIndex);

    assert.strictEqual(shape(indexed), shape(live), `прогон ${i}: скан и индекс разошлись`);
  }
});

test('при падающих файловых операциях ни один файл не исчезает с обеих сторон', async (t) => {
  // Самый ценный закон: у приложения вся защита от потери данных построена
  // на служебной папке и журнале, а проверить её можно только отказами.
  // Подменяем операции записи так, чтобы каждая пятая падала.
  const real = { rename: fsp.rename, copyFile: fsp.copyFile, mkdir: fsp.mkdir };
  const boom = (op) => {
    const err = new Error(`отказ ${op}`);
    err.code = pick(['EPERM', 'EBUSY', 'ENAMETOOLONG']);
    return err;
  };
  const restore = () => Object.assign(fsp, real);
  t.after(restore);

  for (let i = 1; i <= 60; i += 1) {
    setSeed(i * 7919 + 101);
    const { src, dst, folders } = await build(t);
    if (!folders.length) continue;

    const before = await snap(dst);
    const srcSnap = await snap(src);
    const plan = await buildRunPlan(src, dst, folders, [], scanner);
    const planned = {
      trash: new Set(plan.trash.map((e) => e.path.toLowerCase())),
      moveFrom: new Set(plan.moves.map((m) => m.from.toLowerCase())),
      conflicts: plan.conflicts.map((c) => c.toLowerCase()),
    };

    fsp.rename = async (...a) => { if (rnd() < 0.2) throw boom('rename'); return real.rename(...a); };
    fsp.copyFile = async (...a) => { if (rnd() < 0.2) throw boom('copyFile'); return real.copyFile(...a); };
    fsp.mkdir = async (...a) => { if (rnd() < 0.2) throw boom('mkdir'); return real.mkdir(...a); };
    try {
      await applyPlan(src, dst, plan, async (p) => real.rename && rmTrash(p));
    } finally {
      restore();
    }
    await restoreStage(dst);

    const after = await snap(dst);
    const lost = [];
    for (const [k, v] of before) {
      if (v === '/') continue;
      if (after.get(k) === v) continue; // цел
      if (planned.trash.has(k)) continue; // запланирован к удалению
      if (planned.moveFrom.has(k)) continue; // переехал по плану
      if (planned.conflicts.some((c) => k === c || k.startsWith(c + '/'))) continue;
      if (after.get(k) === srcSnap.get(k)) continue; // заменён версией источника
      lost.push(`${k}: было ${JSON.stringify(v)}, стало ${JSON.stringify(after.get(k))}`);
    }
    assert.deepStrictEqual(lost, [], `прогон ${i}: файл пропал при отказах`);
  }
});
