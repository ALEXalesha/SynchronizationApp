'use strict';

// Закон памяти обхода: сколько работы одновременно ждёт очереди, не зависит от
// размера дерева.
//
// Обход для размеров и скан для плана ставили задачу на каждый найденный файл сразу,
// как только прочитан список папки: промис, замыкания, запись в очереди ограничителя.
// Одновременно к диску шло не больше 32 обращений, но ждали своей очереди все
// остальные - на дереве в сотни тысяч файлов это сотни тысяч промисов. Снимок кучи
// посреди обхода настоящей папки: 129 тысяч промисов и 360 тысяч замыканий. Живых
// данных было 115 МБ, а куча раздувалась до 460 МБ и процесс до 700 МБ: долгоживущие
// временные объекты уезжают в старое поколение, и сборщик убирает их только редкими
// полными проходами. Очередь к тому же разбиралась через shift() - на массиве в сотни
// тысяч элементов это ещё и медленно. Соседний runPool в том же файле как раз «не
// создаёт промис на каждый элемент - важно для сотен тысяч файлов»; обход и скан так
// не делали.
//
// Спрашивается форма, как в законе масштаба: растёт одно измерение дерева - файлы в
// одной папке или число папок, - и меряется наибольшее число промисов, одновременно
// ждущих разрешения. У здорового обхода оно стоит на месте (работников фиксированное
// число), у обхода «задачу на каждый файл сразу» растёт вместе с деревом, вчетверо на
// учетверённом дереве. Порог ×1.5 - далеко от обоих.
//
// ЧЕГО ЭТОТ ЗАКОН НЕ СПРАШИВАЕТ. Лёгкие записи «что ещё обойти» на стеке работников -
// это не промисы, их закон не видит, и расти они вправе: широкая папка кладёт на стек
// по записи на файл. Запись - путь и ссылка на папку, в десятки раз меньше промиса с
// замыканиями, а путь хранится всё равно.

const { test } = require('node:test');
const assert = require('node:assert');
const async_hooks = require('node:async_hooks');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const { scanFiles, crawlTree, listChildren } = require('../src/fsops');

// Наибольшее число одновременно ждущих промисов за время action.
async function пикПромисов(action) {
  const ждут = new Set();
  let пик = 0;
  const hook = async_hooks.createHook({
    init(id, type) {
      if (type !== 'PROMISE') return;
      ждут.add(id);
      if (ждут.size > пик) пик = ждут.size;
    },
    promiseResolve(id) { ждут.delete(id); },
  });
  hook.enable();
  try {
    await action();
  } finally {
    hook.disable();
  }
  return пик;
}

async function широкое(файлов) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-память-ш-'));
  await fsp.mkdir(path.join(root, 'папка'));
  for (let i = 0; i < файлов; i++) await fsp.writeFile(path.join(root, 'папка', `f${i}.txt`), 'x');
  return root;
}

async function ветвистое(папок) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-память-в-'));
  for (let i = 0; i < папок; i++) {
    // по десять папок на уровень, по три файла в каждой
    const dir = path.join(root, `a${i % 10}`, `b${Math.floor(i / 10) % 10}`, `c${i}`);
    await fsp.mkdir(dir, { recursive: true });
    for (let k = 0; k < 3; k++) await fsp.writeFile(path.join(dir, `f${k}.txt`), 'xy');
  }
  return root;
}

const ДОРОГИ = {
  'обход для размеров': (root) => crawlTree(root, '', () => {}, null, []),
  'скан для плана': (root) => scanFiles(root, '', [], null, () => {}, null, [], []),
};

for (const [дорога, пройти] of Object.entries(ДОРОГИ)) {
  test(`память обхода: ${дорога} - файлы в одной папке x4, ждущих промисов не больше`, async () => {
    const малое = await широкое(400);
    const большое = await широкое(1600);
    try {
      const a = await пикПромисов(() => пройти(малое));
      const b = await пикПромисов(() => пройти(большое));
      assert.ok(b <= a * 1.5 + 20, `ждущих промисов: ${a} на 400 файлах и ${b} на 1600`);
    } finally {
      await fsp.rm(малое, { recursive: true, force: true });
      await fsp.rm(большое, { recursive: true, force: true });
    }
  });

  test(`память обхода: ${дорога} - папок x4, ждущих промисов не больше`, async () => {
    const малое = await ветвистое(100);
    const большое = await ветвистое(400);
    try {
      const a = await пикПромисов(() => пройти(малое));
      const b = await пикПромисов(() => пройти(большое));
      assert.ok(b <= a * 1.5 + 20, `ждущих промисов: ${a} на 100 папках и ${b} на 400`);
    } finally {
      await fsp.rm(малое, { recursive: true, force: true });
      await fsp.rm(большое, { recursive: true, force: true });
    }
  });
}

test('память обхода: список детей с датами - файлов x4, ждущих промисов не больше', async () => {
  const малое = await широкое(400);
  const большое = await широкое(1600);
  try {
    const a = await пикПромисов(() => listChildren(path.join(малое, 'папка'), true));
    const b = await пикПромисов(() => listChildren(path.join(большое, 'папка'), true));
    assert.ok(b <= a * 1.5 + 20, `ждущих промисов: ${a} на 400 файлах и ${b} на 1600`);
  } finally {
    await fsp.rm(малое, { recursive: true, force: true });
    await fsp.rm(большое, { recursive: true, force: true });
  }
});

// Тот же обход должен дать те же ответы, что и раньше: сумма, число, порядок «папка
// после своего содержимого», все файлы ровно по разу.
test('обход работниками: папка отчитывается после всего своего содержимого, итоги верны', async () => {
  const root = await ветвистое(60);
  try {
    const seen = new Map();
    const order = [];
    const total = await crawlTree(root, '', (rel, isDir, size, cnt) => {
      assert.ok(!seen.has(rel), `дважды: ${rel}`);
      seen.set(rel, { isDir, size, cnt });
      order.push(rel);
    }, null, []);
    assert.strictEqual(total.count, 180);
    assert.strictEqual(total.size, 360);
    const files = [...seen].filter(([, v]) => !v.isDir);
    assert.strictEqual(files.length, 180);
    for (const [rel, v] of seen) {
      if (!v.isDir) continue;
      const inside = [...seen.keys()].filter((k) => k.startsWith(rel + '/'));
      const sum = inside.map((k) => seen.get(k)).filter((x) => !x.isDir);
      assert.strictEqual(v.cnt, sum.length, rel);
      assert.strictEqual(v.size, sum.reduce((s, x) => s + x.size, 0), rel);
      for (const k of inside) assert.ok(order.indexOf(k) < order.indexOf(rel), `${k} после ${rel}`);
    }
    const scanned = await scanFiles(root);
    assert.deepStrictEqual(scanned.map((f) => f.path).sort(), files.map(([k]) => k).sort());
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('обход работниками: брошенное из onEntry останавливает обход и доходит до вызывающего', async () => {
  const root = await ветвистое(80);
  try {
    let calls = 0;
    await assert.rejects(
      crawlTree(root, '', () => { calls += 1; if (calls === 25) throw new Error('toobig'); }, null, []),
      /toobig/,
    );
    const after = calls;
    await new Promise((r) => setTimeout(r, 200));
    // Работники доделывают только то, что уже держали в руках, - новых отчётов нет.
    assert.ok(calls - after <= 40, `после остановки ещё ${calls - after} отчётов`);
    let n = 0;
    await assert.rejects(scanFiles(root, '', [], null, () => { n += 1; if (n === 30) throw new Error('aborted'); }), /aborted/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
