'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { rootsOverlap } = require('../src/paths');

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
