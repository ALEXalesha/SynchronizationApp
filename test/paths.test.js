'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pruneDescendants, rootsOverlap } = require('../src/paths');

test('убирает вложенные пути под выбранным предком', () => {
  const r = pruneDescendants(['docs', 'docs/2024', 'docs/2024/q1', 'pics']);
  assert.deepStrictEqual(r, ['docs', 'pics']);
});

test('оставляет непересекающиеся ветки', () => {
  const r = pruneDescendants(['a/b', 'a/c', 'd']);
  assert.deepStrictEqual(r, ['a/b', 'a/c', 'd']);
});

test('не считает префикс имени вложенностью', () => {
  // 'docs2' не вложен в 'docs' — это другое имя, а не подпапка.
  const r = pruneDescendants(['docs', 'docs2']);
  assert.deepStrictEqual(r, ['docs', 'docs2']);
});

test('убирает дубликаты', () => {
  const r = pruneDescendants(['x', 'x', 'x/y']);
  assert.deepStrictEqual(r, ['x']);
});

// Корни синхронизации не должны пересекаться: копирование папки внутрь самой
// себя разрастается на ходу и никогда не сходится.
test('rootsOverlap ловит вложенность корней в обе стороны', () => {
  const base = path.resolve('data');
  assert.strictEqual(rootsOverlap(base, path.join(base, 'backup')), true);
  assert.strictEqual(rootsOverlap(path.join(base, 'backup'), base), true);
});

test('rootsOverlap считает одну и ту же папку пересечением', () => {
  const base = path.resolve('data');
  assert.strictEqual(rootsOverlap(base, base), true);
  assert.strictEqual(rootsOverlap(base, base + path.sep), true);
});

test('rootsOverlap пропускает соседние папки и общий префикс имени', () => {
  const a = path.resolve('data');
  assert.strictEqual(rootsOverlap(a, path.resolve('pics')), false);
  // 'data2' начинается на 'data', но подпапкой не является.
  assert.strictEqual(rootsOverlap(a, path.resolve('data2')), false);
});
