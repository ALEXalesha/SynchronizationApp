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
    // развернул ветку и снял в ней пару галочек. Больше половины кликов нарочно
    // приходится внутрь уже отмеченного: сам по себе случайный выбор из всего
    // дерева давал вложенную пару «исключено, а внутри снова включено» один раз
    // на тридцать прогонов, а весь смысл трёхпозиционного выбора именно в ней.
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
    const { folders, excludes } = ui.collectSelection();
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

    const names = new Set();
    for (const root of [src, dst]) {
      for (const d of await fsp.readdir(root)) if (d !== STAGE_DIR) names.add(d);
    }
    if (names.size === 0) continue;

    const args = {
      localPath: src, networkPath: dst,
      folders: [...names], excludes: [], direction: 'toNetwork',
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
