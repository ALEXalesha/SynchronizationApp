'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { planSync, summarize, isChanged } = require('../src/sync');

const f = (path, size, mtimeMs) => ({ path, size, mtimeMs });

test('файл только в источнике → копировать', () => {
  const plan = planSync([f('a.txt', 10, 1000)], []);
  assert.strictEqual(plan.copy.length, 1);
  assert.strictEqual(plan.copy[0].path, 'a.txt');
  assert.strictEqual(plan.overwrite.length, 0);
  assert.strictEqual(plan.trash.length, 0);
});

test('файл только в приёмнике → в Корзину', () => {
  const plan = planSync([], [f('old.txt', 5, 500)]);
  assert.strictEqual(plan.trash.length, 1);
  assert.strictEqual(plan.trash[0].path, 'old.txt');
  assert.strictEqual(plan.copy.length, 0);
});

test('одинаковые файлы → без изменений', () => {
  const plan = planSync([f('a.txt', 10, 1000)], [f('a.txt', 10, 1000)]);
  assert.strictEqual(plan.unchanged.length, 1);
  assert.strictEqual(plan.copy.length, 0);
  assert.strictEqual(plan.overwrite.length, 0);
  assert.strictEqual(plan.trash.length, 0);
});

test('разный размер → перезаписать', () => {
  const plan = planSync([f('a.txt', 20, 1000)], [f('a.txt', 10, 1000)]);
  assert.strictEqual(plan.overwrite.length, 1);
});

test('разный mtime сверх порога → перезаписать', () => {
  const plan = planSync([f('a.txt', 10, 10000)], [f('a.txt', 10, 1000)]);
  assert.strictEqual(plan.overwrite.length, 1);
});

test('mtime в пределах порога → без изменений', () => {
  const plan = planSync([f('a.txt', 10, 2500)], [f('a.txt', 10, 1000)]);
  assert.strictEqual(plan.unchanged.length, 1);
  assert.strictEqual(plan.overwrite.length, 0);
});

test('вложенные пути обрабатываются по полному пути', () => {
  const src = [f('sub/a.txt', 10, 1000), f('sub/b.txt', 5, 900)];
  const dst = [f('sub/a.txt', 10, 1000), f('sub/c.txt', 7, 800)];
  const plan = planSync(src, dst);
  assert.deepStrictEqual(plan.copy.map((e) => e.path), ['sub/b.txt']);
  assert.deepStrictEqual(plan.trash.map((e) => e.path), ['sub/c.txt']);
  assert.deepStrictEqual(plan.unchanged.map((e) => e.path), ['sub/a.txt']);
});

test('summarize считает итоги и total', () => {
  const plan = planSync(
    [f('a', 1, 1), f('b', 2, 1), f('c', 3, 1)],
    [f('a', 9, 1), f('x', 1, 1)]
  );
  // a перезаписать, b и c копировать, x в корзину
  const s = summarize(plan);
  assert.strictEqual(s.copy, 2);
  assert.strictEqual(s.overwrite, 1);
  assert.strictEqual(s.trash, 1);
  assert.strictEqual(s.total, 4);
});

test('isChanged: одинаковый размер и время → false', () => {
  assert.strictEqual(isChanged(f('a', 10, 1000), f('a', 10, 1000)), false);
});
