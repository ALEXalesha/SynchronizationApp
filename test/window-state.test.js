'use strict';

// Место окна между запусками (src/window-state.js, 1.1.0). Модуль тот же, что в
// калькуляторах и Paint Pro. Главное - не «запомнило ли», а «что бы ни лежало в файле,
// окно откроется там, где его видно и можно взять за заголовок»: монитор могли
// отключить, разрешение уменьшить, файл обрезать. Случайные прогоны - с зерном.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WS = require('../src/window-state');
const { loadMain } = require('./helpers/main-harness');

const OPTS = { width: 900, height: 600, minWidth: 900, minHeight: 600 };
const FULL_HD = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

test('без файла - по центру, размер постоянный', () => {
  assert.deepStrictEqual(WS.restore(null, [FULL_HD], OPTS), { width: 900, height: 600, maximized: false });
});

test('окно на экране открывается ровно там, где было', () => {
  const saved = { x: 300, y: 200, width: 900, height: 600, maximized: false };
  assert.deepStrictEqual(WS.restore(saved, [FULL_HD], OPTS), saved);
});

test('второй монитор отключили - окно по центру основного', () => {
  const saved = { x: 2500, y: 100, width: 900, height: 600, maximized: false };
  assert.deepStrictEqual(WS.restore(saved, [FULL_HD, RIGHT], OPTS), saved);
  assert.deepStrictEqual(WS.restore(saved, [FULL_HD], OPTS), { width: 900, height: 600, maximized: false });
});

test('окно, заехавшее за край, придвигается к экрану целиком', () => {
  assert.deepStrictEqual(WS.restore({ x: 1800, y: 900, width: 900, height: 600 }, [FULL_HD], OPTS),
    { x: 1020, y: 440, width: 900, height: 600, maximized: false });
});

test('что бы ни лежало в файле, заголовок на экране, а повтор ничего не меняет', () => {
  const junk = (r) => {
    const pick = [() => undefined, () => NaN, () => 'x', () => r() * 1e5 - 5e4, () => int(r, -20000, 20000)];
    const v = () => pick[int(r, 0, pick.length - 1)]();
    return r() < 0.2 ? [null, 42, 'x', [], {}][int(r, 0, 4)] : { x: v(), y: v(), width: v(), height: v() };
  };
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const screens = [];
    let x = int(r, -5000, 5000);
    for (let i = int(r, 1, 3); i > 0; i--) {
      const a = { x, y: int(r, -3000, 3000), width: int(r, 1024, 4000), height: int(r, 700, 2500) };
      screens.push(a);
      x += a.width;
    }
    const w = WS.restore(junk(r), screens, OPTS);
    const ctx = 'зерно ' + seed;
    assert.ok(w.width >= 900 && w.height >= 600, ctx);
    assert.strictEqual(w.x === undefined, w.y === undefined, ctx);
    if (w.x !== undefined) {
      assert.ok(screens.some((a) => w.x >= a.x && w.y >= a.y && w.x < a.x + a.width
        && w.y + WS.GRIP_HEIGHT <= a.y + a.height), ctx);
      assert.deepStrictEqual(WS.restore(w, screens, OPTS), w, ctx);
    }
  }
});

test('обрезанный или пустой файл - окно по умолчанию, запись не оставляет .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncglass-ws-'));
  try {
    const file = path.join(dir, 'window-state.json');
    assert.strictEqual(WS.save(file, { x: 5, y: 6, width: 900, height: 600, maximized: false }), true);
    assert.deepStrictEqual(WS.load(file), { x: 5, y: 6, width: 900, height: 600, maximized: false });
    assert.strictEqual(fs.existsSync(file + '.tmp'), false);
    for (const text of ['', '{"x": 1', 'null']) {
      fs.writeFileSync(file, text);
      assert.deepStrictEqual(WS.restore(WS.load(file), [FULL_HD], OPTS), { width: 900, height: 600, maximized: false });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main.js открывает окно на сохранённом месте и с постоянным размером', async () => {
  const saved = { x: 321, y: 123, width: 1400, height: 1000, maximized: false };
  const { windows } = await loadMain({
    seed: (dir) => fs.promises.writeFile(path.join(dir, 'window-state.json'), JSON.stringify(saved)),
  });
  assert.strictEqual(windows.length, 1);
  const o = windows[0];
  assert.deepStrictEqual([o.x, o.y, o.width, o.height, o.resizable], [321, 123, 900, 600, false]);
});

test('модуль тот же, что в калькуляторах, кроме комментариев сверху', (t) => {
  const calc = path.join(__dirname, '..', '..', 'Calculators', 'calcpro-glass', 'window-state.js');
  if (!fs.existsSync(calc)) { t.skip('калькуляторов рядом нет (CI)'); return; }
  const body = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('const finite')[1];
  assert.strictEqual(body(path.join(__dirname, '..', 'src', 'window-state.js')), body(calc));
});
