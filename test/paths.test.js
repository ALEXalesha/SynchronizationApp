'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pruneDescendants } = require('../src/paths');

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
