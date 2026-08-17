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

const { buildRunPlan, scanFromIndex, groupIndexByBranch, countByFolder } = require('../src/plan');
const { ciKey } = require('../src/paths');
const { summarize } = require('../src/sync');
const { scanFiles, crawlTree, applyPlan, restoreStage, STAGE_DIR } = require('../src/fsops');
const { loadRenderer } = require('./helpers/renderer-harness');
const { loadMain } = require('./helpers/main-harness');

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

// Ветки верхнего уровня с обеих сторон, схлопнутые по регистру — ровно так их
// собирает `list-folders`, а отметки в дереве лежат под ключом без учёта регистра
// и вторым написанием той же папки стать не могут. Без этого одна и та же ветка
// приходила в план дважды ('Doc0' с источника и 'DOC0' с приёмника), каждый файл
// под ней планировался к удалению по два раза, а отчёт обещал вдвое больше
// удалённого, чем уносил. Интерфейс такого входа не даёт — значит и прогон
// не должен: закон, проверяющий невозможное, ловит только собственные выдумки.
async function верхниеВетки(...roots) {
  const поКлючу = new Map();
  for (const root of roots) {
    for (const d of await fsp.readdir(root)) {
      if (d === STAGE_DIR) continue;
      if (!поКлючу.has(d.toLowerCase())) поКлючу.set(d.toLowerCase(), d);
    }
  }
  return [...поКлючу.values()];
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

// Индекс одной стороны в том же виде, в каком его собирает фоновый обход.
async function indexOfSide(root) {
  const files = new Map();
  const dirs = new Set();
  const skipped = [];
  await crawlTree(root, '', (rel, isFolder, size, cnt, mtimeMs) => {
    if (isFolder) dirs.add(rel);
    else files.set(rel, { size, mtimeMs });
  }, null, skipped);
  return { files, dirs, skipped };
}

// Ветки и исключения, какими их порождает интерфейс: не случайный список путей,
// а последствие кликов по дереву. Только так рождается вложенная пара «выбрано,
// внутри снято, а ещё глубже снова выбрано» — единственный способ получить две
// вложенные ветки разом, и самый тонкий вход для всего, что разбирает выбор.
function кликамиПоДереву(узлы) {
  const ui = loadRenderer();
  const верх = узлы.filter((p) => !p.includes('/'));
  const внутри = (какие) => {
    const отмеченные = [];
    for (const m of ui.state.marks.values()) {
      if (!какие || m.mark === какие) отмеченные.push(m.path.toLowerCase() + '/');
    }
    return узлы.filter((p) => отмеченные.some((m) => p.toLowerCase().startsWith(m)));
  };
  ui.toggleCheck({ relPath: pick(верх.length ? верх : узлы), isDir: true });
  for (let k = 0; k < 14; k += 1) {
    const бросок = rnd();
    // Отдельно целимся внутрь уже снятого: только так рождается «исключено,
    // а внутри снова включено» — случай, ради которого выбор и трёхпозиционный.
    const глубже = бросок < 0.4 ? внутри('exclude') : бросок < 0.75 ? внутри(null) : [];
    ui.toggleCheck({ relPath: pick(глубже.length ? глубже : узлы), isDir: true });
  }
  // Проход по одной цепочке сверху вниз. Клик по каждому предку подряд даёт
  // чередование «включено / исключено / снова включено» гарантированно, а не
  // по счастливой случайности: на одних случайных кликах такая пара выпадала
  // четыре раза на тридцать прогонов, и мутация на ней не ловилась.
  const цепочка = pick(узлы).split('/');
  for (let d = 1; d <= цепочка.length; d += 1) {
    ui.toggleCheck({ relPath: цепочка.slice(0, d).join('/'), isDir: true });
  }
  return { ui, ...ui.collectSelection() };
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

  // Лишнее на приёмнике: то, чего на источнике нет вовсе. Без этого искажённая
  // копия оставалась подмножеством источника, план почти никогда не содержал
  // удалений, и законы про них молчали — мутация «не писать удаления в историю»
  // проходила зелёной.
  const лишних = Math.floor(rnd() * 3);
  for (let i = 0; i < лишних; i += 1) {
    const имя = `лишнее${i}-${Math.floor(rnd() * 1000)}`;
    try {
      if (rnd() < 0.35) {
        await fsp.mkdir(path.join(dst, rel, имя), { recursive: true });
        await fsp.writeFile(path.join(dst, rel, имя, 'внутри.txt'), 'лишнее внутри лишней папки');
      } else {
        await fsp.writeFile(path.join(dst, rel, имя), 'этого нет на источнике');
      }
    } catch {
      // имя уже занято — это тоже часть случая
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

    const idx = { [src]: await indexOfSide(src), [dst]: await indexOfSide(dst) };
    const byIndex = (root, branch, ex) => scanFromIndex(idx[root], branch, ex);

    const live = await buildRunPlan(src, dst, folders, excludes, scanner);
    const indexed = await buildRunPlan(src, dst, folders, excludes, byIndex);

    assert.strictEqual(shape(indexed), shape(live), `прогон ${i}: скан и индекс разошлись`);
  }
});

// Тринадцатый закон. Пятый связал поветочный разбор индекса с живым сканом,
// но сам разбор перебирал весь индекс на каждую ветку, и два законных предела
// перемножались (см. groupIndexByBranch). Раскладка за один проход дешевле
// ровно настолько, насколько она рискованнее: хозяин пути ищется подъёмом,
// а не сравнением префикса, и вложенные ветки с исключением между ними — самый
// тонкий случай. Закон и держит эти два способа за одно место: что отдаёт
// раскладка ветке, то же обязан отдать и перебор. Ветки берём не случайные,
// а кликами по дереву — интерфейс других не порождает, а закон, проверяющий
// невозможный вход, ловит только собственные выдумки.
test('раскладка индекса по веткам совпадает с поветочным разбором', async (t) => {
  const shape = (s) => JSON.stringify({
    files: s.files.map((e) => `${e.path.toLowerCase()}:${e.size}`).sort(),
    dirs: s.dirs.map((d) => d.toLowerCase()).sort(),
    skipped: (s.skipped || []).map((d) => d.toLowerCase()).sort(),
  });
  let вложенных = 0;
  let всего = 0;

  for (let i = 1; i <= 30; i += 1) {
    setSeed(i * 7919 + 1013);
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await fsp.mkdir(src);
    await fsp.mkdir(dst);
    await makeDenseTree(src);
    await perturbedCopy(src, dst);

    const узлы = [...new Set([...(await allPaths(src)), ...(await allPaths(dst))])];
    if (!узлы.length) continue;

    const { folders, excludes } = кликамиПоДереву(узлы);
    if (!folders.length) continue;
    всего += 1;
    // Вложенная пара веток («выбрано docs, снято docs/a, снова выбрано docs/a/b»)
    // и есть случай, ради которого закон написан: без неё подъём по пути и сравнение
    // префикса совпадают тривиально.
    if (folders.some((a) => folders.some((b) => a !== b && ciKey(a).startsWith(ciKey(b) + '/')))) {
      вложенных += 1;
    }

    for (const root of [src, dst]) {
      const idx = await indexOfSide(root);
      const groups = groupIndexByBranch(idx, folders, excludes);
      for (const folder of folders) {
        const перебором = scanFromIndex(idx, folder, excludes);
        const раскладкой = groups.get(ciKey(folder)) || { files: [], dirs: [], skipped: [] };
        assert.strictEqual(
          shape(раскладкой),
          shape(перебором),
          `прогон ${i}: ветка ${folder} разошлась (исключения: ${excludes.join(',') || '—'})`
        );
      }
    }
  }
  // Плотность генератора: закон без вложенных веток ничего не стоит.
  assert.ok(вложенных >= 5, `вложенных пар веток всего ${вложенных} из ${всего} прогонов — генератор до случая не доходит`);
});

// Восьмой закон. Все прочие прогоны зовут buildRunPlan с готовым списком веток
// и исключений, то есть проверяют вторую половину пути. Первую — от клика
// до этого списка — не проверял никто, хотя баги прошлых сессий сидели именно
// там: узлы дерева, отметки, ключи выбора. Здесь кликают случайно и вглубь,
// а закон сверяет две независимые вещи: что показывает строка на экране
// (isIncluded) и что после этого действительно происходит с файлом на диске.
test('что отмечено на экране, то и синхронизируется — и ничего сверх того', async (t) => {
  for (let i = 1; i <= 30; i += 1) {
    setSeed(i * 7919 + 313);
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await fsp.mkdir(src);
    await fsp.mkdir(dst);
    await makeDenseTree(src);
    await perturbedCopy(src, dst);

    const узлы = [...new Set([...(await allPaths(src)), ...(await allPaths(dst))])];
    if (!узлы.length) continue;

    // Клики идут и по верхнему уровню, и вглубь — как у человека, который
    // развернул ветку и снял в ней пару галочек.
    const { ui, folders, excludes } = кликамиПоДереву(узлы);
    if (!folders.length) continue;

    const доПрогона = await snap(dst);
    const наИсточнике = await snap(src);
    const plan = await buildRunPlan(src, dst, folders, excludes, scanner);
    const res = await applyPlan(src, dst, plan, rmTrash);
    assert.deepStrictEqual(res.failures, [], `прогон ${i}: ошибки на ровном месте`);
    const после = await snap(dst);

    const нарушения = [];
    for (const [ключ, было] of наИсточнике) {
      if (было === '/') continue;
      const отмечен = ui.isIncluded(ключ);
      if (отмечен && после.get(ключ) !== было) {
        нарушения.push(`${ключ}: отмечен на экране, но на приёмнике ${JSON.stringify(после.get(ключ))}`);
      }
      // Неотмеченный файл приёмник обязан оставить ровно таким, каким он был:
      // ни скопировать, ни перезаписать, ни удалить.
      if (!отмечен && после.get(ключ) !== доПрогона.get(ключ)) {
        нарушения.push(`${ключ}: не отмечен, а на приёмнике поменялся`);
      }
    }
    for (const [ключ, было] of доПрогона) {
      if (было === '/' || наИсточнике.has(ключ)) continue;
      if (ui.isIncluded(ключ)) continue; // отмечен и лишний — законно в Корзину
      if (после.get(ключ) !== было) нарушения.push(`${ключ}: не отмечен, а с приёмника пропал`);
    }
    assert.deepStrictEqual(
      нарушения,
      [],
      `прогон ${i}: экран и диск разошлись (ветки: ${folders.join(',')}; исключения: ${excludes.join(',') || '—'})`
    );
  }
});

// Имитация вылета посреди работы: часть файлов остаётся лежать в служебной папке,
// а прибраться за ними уже некому. Настоящий applyPlan так не заканчивает — он либо
// доводит дело до конца, либо откатывает, — поэтому единственный способ получить
// такое состояние в прогоне это сделать его руками.
async function crashLeftovers(root) {
  for (const rel of await allPaths(root)) {
    if (rel === STAGE_DIR || rel.startsWith(`${STAGE_DIR}/`)) continue;
    if (rnd() > 0.25) continue;
    try {
      if (!(await fsp.stat(path.join(root, rel))).isFile()) continue;
      const parked = path.join(root, STAGE_DIR, rel);
      await fsp.mkdir(path.dirname(parked), { recursive: true });
      await fsp.rename(path.join(root, rel), parked);
    } catch {
      // не вышло отложить — этот файл просто не участвует в имитации
    }
  }
}

// Седьмой закон. Прогон делался один, максимум два подряд, и всегда в одну
// сторону: последовательность «прогон туда → обрыв → прогон обратно → вылет»
// не порождалась ничем, а служебная папка от одного запуска в руках следующего
// держалась на единственном точечном тесте. Здесь направление, точка обрыва
// и вылет выбираются случайно, а законов сразу три: источник не трогают никогда,
// оборванный прогон возвращает приёмник как было, доведённый — сводит стороны.
test('цепочка прогонов в обе стороны с обрывами и вылетами ничего не теряет', async (t) => {
  for (let i = 1; i <= 30; i += 1) {
    setSeed(i * 7919 + 211);
    const { src: a, dst: b } = await build(t);

    for (let step = 1; step <= 4; step += 1) {
      const метка = `прогон ${i}, шаг ${step}`;
      const вылет = rnd() < 0.35;
      const доВылета = вылет ? [await snap(a), await snap(b)] : null;
      if (вылет) await crashLeftovers(rnd() < 0.5 ? a : b);

      // Так же, как это делает performSync: разбираем обе стороны, а не только
      // приёмник. Оборвавшийся запуск мог идти в другую сторону, и тогда оригиналы
      // лежат в том корне, который сейчас источник.
      for (const root of [a, b]) await restoreStage(root);
      if (доВылета) {
        assert.deepStrictEqual(
          [diffOf(доВылета[0], await snap(a)), diffOf(доВылета[1], await snap(b))],
          [[], []],
          `${метка}: разбор служебной папки не вернул отложенное на место`
        );
      }

      const toB = rnd() < 0.5;
      const from = toB ? a : b;
      const to = toB ? b : a;
      const names = new Set();
      for (const root of [a, b]) {
        for (const d of await fsp.readdir(root)) if (d !== STAGE_DIR) names.add(d);
      }
      if (names.size === 0) continue;

      const былоНаИсточнике = await snap(from);
      const былоНаПриёмнике = await snap(to);
      const plan = await buildRunPlan(from, to, [...names], [], scanner);
      const total = summarize(plan).total;

      const stopAt = rnd() < 0.5 ? Math.floor(rnd() * (total + 1)) : total + 1;
      let done = 0;
      const res = await applyPlan(from, to, plan, rmTrash, () => { done += 1; }, {
        shouldStop: () => done >= stopAt,
      });

      assert.deepStrictEqual(
        diffOf(былоНаИсточнике, await snap(from)),
        [],
        `${метка}: источник изменился, а трогать его нельзя никогда`
      );
      if (res.cancelled) {
        assert.deepStrictEqual(
          diffOf(былоНаПриёмнике, await snap(to)),
          [],
          `${метка}: обрыв на ${stopAt}/${total} не вернул приёмник`
        );
      } else {
        assert.deepStrictEqual(
          diffOf(await snap(from), await snap(to)),
          [],
          `${метка}: доведённый до конца прогон не свёл стороны`
        );
      }
    }
  }
});

// Десятый закон. Всё остальное считается по статичному снимку: план построен —
// дерево замерло. В жизни оно не замирает. Скан и запись разделены минутами,
// и между ними файл успевают удалить, дописать, переименовать и подменить папкой.
// Гонки до сих пор проверялись только точечно, подменой конкретного `stat`,
// а тут дерево меняется прямо посреди работы.
//
// Порчу вносим по счётчику действий, а не по таймеру: тогда «на каком шаге
// дерево дрогнуло» — часть засеянного случая, и упавший прогон повторяется
// дословно. По таймеру он не повторился бы ни разу.
// Возвращает путь, который тронула, — иначе испорченное самим прогоном
// не отличить от испорченного нами.
//
// `цели` — пути, которые есть в плане. Без прицела вандал бил наугад по всему
// дереву и до случая «файл, обещанный к перезаписи, исчез ровно перед
// копированием» не доходил ни разу: мутация «не возвращать оригинал» проходила
// зелёной. Случайность тут нужна в том, КОГДА рушится, а не в том, что именно.
async function vandalize(root, тронутые, цели = []) {
  const файлы = [];
  for (const rel of await allPaths(root)) {
    if (rel === STAGE_DIR || rel.startsWith(`${STAGE_DIR}/`)) continue;
    файлы.push(rel);
  }
  if (!файлы.length) return;
  const вПлане = цели.filter((c) => файлы.some((f) => f.toLowerCase() === c.toLowerCase()));
  const rel = вПлане.length && rnd() < 0.75 ? pick(вПлане) : pick(файлы);
  if (тронутые) тронутые.add(rel.toLowerCase());
  const abs = path.join(root, rel);
  const бросок = rnd();
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) {
      // Папку сносим целиком: так посреди работы исчезает не файл, а ветка.
      if (бросок < 0.5) await fsp.rm(abs, { recursive: true, force: true });
      return;
    }
    if (бросок < 0.35) await fsp.rm(abs);
    else if (бросок < 0.6) await fsp.writeFile(abs, `дописано ${rnd()}`);
    else if (бросок < 0.8) {
      // Файл сменился папкой прямо под руками: копирование по этому пути теперь
      // упрётся в каталог, а обход по нему пойдёт вглубь.
      await fsp.rm(abs);
      await fsp.mkdir(abs, { recursive: true });
      await fsp.writeFile(path.join(abs, 'подменыш.txt'), 'этого не было в плане');
    } else await fsp.writeFile(path.join(root, `${rel}.новый`), 'появился по ходу работы');
  } catch {
    // не вышло испортить — этот шаг просто проходит спокойно
  }
}

test('дерево, изменившееся посреди работы, не уносит с собой чужие файлы', async (t) => {
  for (let i = 1; i <= 60; i += 1) {
    setSeed(i * 7919 + 503);
    // Приёмник — искажённая копия источника, а не отдельное случайное дерево:
    // на независимых деревьях пути почти не совпадают, перезаписей в плане
    // единицы, и портить посреди работы оказывается нечего.
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await fsp.mkdir(src);
    await fsp.mkdir(dst);
    await makeDenseTree(src);
    await perturbedCopy(src, dst);
    const folders = await верхниеВетки(src, dst);
    if (!folders.length) continue;

    const доПрогона = await snap(dst);
    const plan = await buildRunPlan(src, dst, folders, [], scanner);
    const total = summarize(plan).total;
    if (total === 0) continue;
    // Закон формулируем от обратного: не «изменившееся совпадает с источником»
    // (источник тут сам меняется под руками, и сверять с ним нечего), а «того,
    // чего не было в плане, работа не касалась вовсе». Это и есть обещание
    // приложения: приёмник меняется ровно там, где обещал предпросмотр.
    const вПлане = new Set();
    for (const e of [...plan.trash, ...plan.copy, ...plan.overwrite]) вПлане.add(e.path.toLowerCase());
    for (const m of plan.moves) {
      вПлане.add(m.from.toLowerCase());
      вПлане.add(m.to.toLowerCase());
    }
    const конфликты = plan.conflicts.map((c) => c.toLowerCase());
    // Исчезнуть с приёмника имеет право только то, что и планировалось убрать.
    const запланированоУбрать = new Set([
      ...plan.trash.map((e) => e.path.toLowerCase()),
      ...plan.moves.map((m) => m.from.toLowerCase()),
    ]);

    // Портим обе стороны: источник уходит из-под копирования, приёмник —
    // из-под удаления. Вторая половина важнее: там чужая правка встречается
    // с нашей записью.
    const порчаНа = new Set([1]);
    // Первая точка всегда первая, и на ней бьём прицельно (см. ниже). Случайные
    // точки к этому добавляются, но полагаться на них нельзя: замер показал
    // 62 перезаписи на 55 прогонов и ни одного случая «источник исчез до своей
    // очереди» — перезаписи идут последней фазой и составляют считаные проценты
    // шагов, так что случайный бросок в них почти не попадает.
    const точек = Math.min(3, total);
    while (порчаНа.size < точек) порчаНа.add(1 + Math.floor(rnd() * total));
    let done = 0;
    let сорвалось = null;
    // Отчёт о прогрессе никто не дожидается — `report` зовёт его и идёт дальше.
    // Значит порча продолжается и после возврата из applyPlan, а снимок, снятый
    // в этот момент, ловит дерево прямо посреди правки. Собираем обещания
    // и дожидаемся их сами.
    const порча = [];
    const испорченоНаПриёмнике = new Set();
    const целиИсточника = [...plan.overwrite.map((e) => e.path), ...plan.copy.map((e) => e.path)];
    const целиПриёмника = [...plan.overwrite.map((e) => e.path), ...plan.trash.map((e) => e.path)];
    try {
      await applyPlan(src, dst, plan, rmTrash, () => {
        done += 1;
        if (!порчаНа.has(done)) return;
        // На первом же шаге сносим с источника файл, обещанный к перезаписи.
        // Его очередь ещё не подошла, и когда подойдёт, копировать будет нечего:
        // оригинал приёмника к тому моменту уже отложен в служебную папку, и его
        // обязаны вернуть на место. Это самая злая из гонок и единственная,
        // до которой случайный бросок не доходит.
        if (done === 1 && plan.overwrite.length) {
          порча.push(fsp.rm(path.join(src, pick(plan.overwrite).path)).catch(() => {}));
          return;
        }
        const вПриёмник = rnd() < 0.5;
        порча.push(
          вПриёмник
            ? vandalize(dst, испорченоНаПриёмнике, целиПриёмника)
            : vandalize(src, null, целиИсточника)
        );
      });
    } catch (err) {
      сорвалось = err;
    }
    await Promise.all(порча);
    const испорчено = (k) => {
      for (const p of испорченоНаПриёмнике) if (k === p || k.startsWith(`${p}/`)) return true;
      return false;
    };
    assert.strictEqual(
      сорвалось,
      null,
      `прогон ${i}: работа сорвалась исключением вместо того, чтобы записать осечку (${сорвалось && сорвалось.message})`
    );

    // Сверяем сразу, без restoreStage. Разбор служебной папки на старте
    // следующего запуска — страховка на случай вылета, а доведённый до конца
    // прогон обязан оставить приёмник верным сам. Подмешай мы сюда разбор — он
    // вернул бы то, что прогон потерял, и потеря прошла бы незамеченной.
    // Проверено мутацией: с ним закон не ловит невозвращённый оригинал.
    const послеПрогона = await snap(dst);
    const тронуто = [];
    const пропало = [];
    for (const [k, v] of доПрогона) {
      if (v === '/' || испорчено(k)) continue;
      // Половина первая: чего не было в плане, того работа не касалась вовсе.
      if (послеПрогона.get(k) !== v && !вПлане.has(k) && !конфликты.some((c) => k === c || k.startsWith(`${c}/`))) {
        тронуто.push(`${k}: было ${JSON.stringify(v)}, стало ${JSON.stringify(послеПрогона.get(k))}`);
      }
      // Половина вторая: пропасть без следа имеет право только то, что и должно
      // было исчезнуть. Файл, обещанный к перезаписи, обязан остаться на месте
      // хоть в каком-то виде: если источник исчез посреди работы, оригинал
      // возвращают из служебной папки, а не оставляют дыру.
      if (послеПрогона.get(k) !== undefined) continue;
      if (запланированоУбрать.has(k)) continue;
      if (конфликты.some((c) => k === c || k.startsWith(`${c}/`))) continue;
      пропало.push(k);
    }
    assert.deepStrictEqual(
      тронуто,
      [],
      `прогон ${i}: правка на ходу утащила за собой файл, которого не было в плане`
    );
    assert.deepStrictEqual(
      пропало,
      [],
      `прогон ${i}: файл исчез с приёмника, хотя убирать его никто не собирался`
    );
  }
});

// Одиннадцатый закон. Вес вызова Корзины — это обещание: «столько файлов
// покрывает этот вызов». На нём главный процесс считает «удалено безвозвратно»,
// и на сетевом приёмнике, где Корзины нет вовсе, эта цифра — единственное, что
// человек узнает о потере. Проверялось это одним точечным тестом на конфликт
// типа; здесь обещание сверяется с последствием на случайных деревьях.
//
// Смотрим именно на обещание, а не на настоящее «мимо Корзины»: безвозвратно
// файлы уходят только на UNC-пути, а его в прогоне не сделать. Зато `trashFn`
// подменяется, и что бы главный процесс ни решил делать дальше, считать он
// будет по этому весу.
async function countFilesUnder(abs) {
  let dirents;
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return 1; // не папка — значит один узел
  }
  let n = 0;
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    n += d.isDirectory() ? await countFilesUnder(path.join(abs, d.name)) : 1;
  }
  return n;
}

test('вес вызова Корзины равен числу файлов, которые этот вызов уносит', async (t) => {
  for (let i = 1; i <= 40; i += 1) {
    setSeed(i * 7919 + 607);
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await fsp.mkdir(src);
    await fsp.mkdir(dst);
    await makeDenseTree(src);
    await perturbedCopy(src, dst);
    const folders = await верхниеВетки(src, dst);
    if (!folders.length) continue;

    let обещано = 0;
    let унесено = 0;
    const считающаяКорзина = async (abs, вес = 1) => {
      обещано += вес;
      унесено += await countFilesUnder(abs);
      await fsp.rm(abs, { recursive: true, force: true });
    };

    const plan = await buildRunPlan(src, dst, folders, [], scanner);
    if (summarize(plan).total === 0) continue;
    await applyPlan(src, dst, plan, считающаяКорзина);

    assert.strictEqual(
      обещано,
      унесено,
      `прогон ${i}: обещали вес ${обещано}, а унесли ${унесено} файлов`
    );
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

// Девятый закон. «Предпросмотр не врёт» есть, а «история не врёт» не было:
// запись в журнале — единственный отчёт, который переживает закрытие окна,
// и проверялась она до сих пор только глазами. Сверяем в обе стороны: каждая
// строка записи подтверждается диском, и каждый изменившийся файл назван
// в записи. Односторонняя проверка ловит выдумки, но не умолчания.
test('история не врёт: перечисленное в записи совпадает с тем, что стало с диском', async (t) => {
  const { call } = await loadMain();

  for (let i = 1; i <= 20; i += 1) {
    setSeed(i * 7919 + 401);
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-inv-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    const src = path.join(base, 'src');
    const dst = path.join(base, 'dst');
    await fsp.mkdir(src);
    await fsp.mkdir(dst);
    await makeDenseTree(src);
    await perturbedCopy(src, dst);

    const folders = await верхниеВетки(src, dst);
    if (!folders.length) continue;

    // Направление чередуем: `src` и `dst` тут всегда источник и приёмник, а вот
    // какая из сторон при этом «локальная», решает направление — и от него
    // зависит и Корзина, и то, какой корень главный процесс разбирает первым.
    // Обратная сторона до сих пор проверялась только точечными тестами.
    const кСети = i % 2 === 1;
    const args = {
      localPath: кСети ? src : dst,
      networkPath: кСети ? dst : src,
      folders, excludes: [], direction: кСети ? 'toNetwork' : 'toLocal',
    };
    const до = await snap(dst);
    const наИсточнике = await snap(src);
    await call('clear-history');
    const pv = await call('preview', args);
    const res = await call('sync', args);
    assert.ok(!res.error, `прогон ${i}: синхронизация не прошла (${res.error})`);
    const после = await snap(dst);
    const [запись] = await call('get-history');

    if (pv.totals.total === 0) {
      assert.strictEqual(запись, undefined, `прогон ${i}: пустой прогон оставил запись`);
      continue;
    }
    assert.deepStrictEqual(
      запись.totals,
      {
        move: pv.totals.move, copy: pv.totals.copy, overwrite: pv.totals.overwrite,
        trash: pv.totals.trash, dirs: pv.totals.dirs,
      },
      `прогон ${i}: итоги записи разошлись с предпросмотром`
    );

    const врёт = [];
    const названо = new Set();
    for (const { action, path: строка } of запись.files) {
      const пути = action === 'move' ? строка.split(' → ') : [строка];
      for (const p of пути) названо.add(p.toLowerCase());
      const цель = пути[пути.length - 1].toLowerCase();
      if (action === 'trash') {
        if (после.get(цель) === до.get(цель)) врёт.push(`${строка}: отчитались об удалении, а узел на месте`);
      } else if (после.get(цель) === undefined) {
        // Отдельной веткой, а не общим сравнением: у выдуманного пути «нет
        // на приёмнике» и «нет на источнике» — это два undefined, и они сходятся.
        врёт.push(`${строка}: отчитались о «${action}», а такого узла на приёмнике нет`);
      } else if (после.get(цель) !== наИсточнике.get(цель)) {
        врёт.push(`${строка}: отчитались о «${action}», а на приёмнике ${JSON.stringify(после.get(цель))}`);
      }
    }
    assert.deepStrictEqual(врёт, [], `прогон ${i}: запись обещает то, чего на диске нет`);

    // Обратная сторона: молчание тоже ложь. Папки в перечень не идут (они
    // считаются отдельной строкой итогов), поэтому спрашиваем только про файлы.
    if (запись.filesTruncated === 0) {
      const умолчали = [];
      for (const ключ of new Set([...до.keys(), ...после.keys()])) {
        if (до.get(ключ) === после.get(ключ)) continue;
        if (до.get(ключ) === '/' || после.get(ключ) === '/') continue;
        if (!названо.has(ключ)) умолчали.push(`${ключ}: ${JSON.stringify(до.get(ключ))} → ${JSON.stringify(после.get(ключ))}`);
      }
      assert.deepStrictEqual(умолчали, [], `прогон ${i}: файл изменился, а в истории о нём ни слова`);
    }
  }
});

// Двенадцатый закон. `escapeHtml` проверялся сам по себе — он верный. Но верная
// функция ничего не значит, если её забыли позвать: разметка собирается
// `innerHTML` в трёх разных местах, и «здесь экранируем, а здесь и так сойдёт» —
// ровно то расхождение соседей, которое эта ревизия ловила уже дважды.
// Поэтому спрашиваем не функцию, а результат: имя, пришедшее с диска, не имеет
// права оказаться в разметке разметкой.
//
// Имена файлов на Windows не могут содержать `<` и `"`, зато могут `&`, `'`
// и `#`. Проверяем всё равно всем набором: имена приходят и с сетевых шар,
// и из истории, записанной другой версией, а разбирать по одному, что «здесь
// невозможно», — способ однажды ошибиться.
const ЗЛОЕ = `<i&"'>злое`;
const ЭКРАНИРОВАННОЕ = '&lt;i&amp;&quot;&#39;&gt;злое';

// Вся разметка поддерева: innerHTML лежит на каждом узле заглушки отдельно.
function всяРазметка(узел, out = []) {
  if (typeof узел.innerHTML === 'string' && узел.innerHTML) out.push(узел.innerHTML);
  for (const ребёнок of узел.children || []) всяРазметка(ребёнок, out);
  return out;
}

test('имя с диска не становится разметкой ни в одном окне', async () => {
  const проверки = [];

  for (let i = 1; i <= 12; i += 1) {
    setSeed(i * 7919 + 701);
    const имя = `${pick(['', 'a', 'папка'])}${ЗЛОЕ}${Math.floor(rnd() * 100)}`;
    const ui = loadRenderer();

    // Дерево: строка со злым именем на обеих сторонах.
    ui.state.roots = [ui.makeNode({ name: имя, relPath: имя, isDir: rnd() < 0.5, hasLocal: true, hasNetwork: true })];
    ui.__ctx.renderTree();
    проверки.push(...всяРазметка(ui.el.localList), ...всяРазметка(ui.el.networkList));

    // Предпросмотр: имя ветки и путь узла, закрытого правами.
    ui.renderPreview({
      perFolder: [{ folder: имя, summary: { move: 0, copy: 1, overwrite: 0, trash: 0, dirs: 0, total: 1 } }],
      totals: { move: 0, copy: 1, overwrite: 0, trash: 1, dirs: 1, total: 3 },
      destTrashable: false,
      skipped: [имя],
      skippedTotal: 1,
    });
    проверки.push(ui.el.previewSummary.innerHTML, ui.el.previewList.innerHTML);

    // История: перечень файлов запуска.
    проверки.push(
      ui.historyFilesHtml({ files: [{ action: pick(['copy', 'trash', 'move', 'overwrite']), path: имя }] })
    );
  }

  const сырое = проверки.filter((html) => html.includes(ЗЛОЕ));
  assert.deepStrictEqual(
    сырое,
    [],
    'имя попало в разметку как есть — где-то забыли escapeHtml'
  );
  assert.ok(
    проверки.some((html) => html.includes(ЭКРАНИРОВАННОЕ)),
    'ни одно окно не показало имя вовсе — закон проверял пустоту'
  );
});
