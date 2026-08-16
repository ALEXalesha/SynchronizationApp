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

const { detectMoves, planDirs } = require('../src/sync');

test('перемещение находится, даже если приёмник округлил дату (сеть, FAT)', () => {
  // На шаре дата после копирования отличается на доли секунды. Раньше это ломало
  // сопоставление, и перенос выглядел как удалить + скопировать заново.
  const plan = detectMoves(
    planSync(
      [f('Архив/скан.pdf', 100500, 1700000000000)],
      [f('Входящие/скан.pdf', 100500, 1700000001300)]
    )
  );
  assert.strictEqual(plan.moves.length, 1);
  assert.strictEqual(plan.moves[0].from, 'Входящие/скан.pdf');
  assert.strictEqual(plan.moves[0].to, 'Архив/скан.pdf');
});

test('одинаковое имя и размер, но дата разошлась сильно — это разные файлы', () => {
  const plan = detectMoves(
    planSync(
      [f('Новая/док.txt', 50, 1700000000000)],
      [f('Старая/док.txt', 50, 1600000000000)]
    )
  );
  assert.strictEqual(plan.moves.length, 0);
  assert.strictEqual(plan.copy.length, 1);
  assert.strictEqual(plan.trash.length, 1);
});

test('planDirs удаляет от глубоких к мелким, создаёт от мелких к глубоким', () => {
  const dirs = planDirs(['a', 'a/b', 'a/b/c'], ['x', 'x/y']);
  assert.deepStrictEqual(dirs.create, ['a', 'a/b', 'a/b/c']);
  assert.deepStrictEqual(dirs.remove, ['x/y', 'x']);
});

test('summarize учитывает перемещения и папки в total', () => {
  const plan = detectMoves(planSync([f('n/a.txt', 1, 1)], [f('o/a.txt', 1, 1)]));
  plan.dirs = { create: ['n'], remove: ['o'] };
  const s = summarize(plan);
  assert.strictEqual(s.move, 1);
  assert.strictEqual(s.copy, 0);
  assert.strictEqual(s.dirs, 2);
  assert.strictEqual(s.total, 3);
});

// ---- Регистр в путях ----
// NTFS и сетевые шары не различают 'Note.txt' и 'note.txt'. Пока сравнение шло
// через ===, один файл выглядел двумя: копия ложилась поверх приёмника, а следом
// исходное написание уезжало в Корзину — и файл пропадал с приёмника совсем.

test('путь отличается только регистром — это один файл, а не копия плюс удаление', () => {
  const plan = planSync([f('док/Заметка.txt', 10, 1000)], [f('док/заметка.txt', 10, 1000)]);
  assert.strictEqual(plan.copy.length, 0);
  assert.strictEqual(plan.trash.length, 0);
  // Перезапись, а не «без изменений»: она начинается с переноса оригинала
  // в служебную папку, поэтому на месте остаётся написание источника.
  assert.strictEqual(plan.overwrite.length, 1);
  assert.strictEqual(plan.overwrite[0].path, 'док/Заметка.txt');
});

test('одинаковое написание и содержимое — по-прежнему без изменений', () => {
  const plan = planSync([f('a.txt', 10, 1000)], [f('a.txt', 10, 1000)]);
  assert.strictEqual(plan.unchanged.length, 1);
  assert.strictEqual(plan.overwrite.length, 0);
});

test('planDirs не сносит папку приёмника, написанную в другом регистре', () => {
  const { create, remove } = planDirs(['Док', 'Док/год'], ['док', 'док/год', 'лишняя']);
  assert.deepStrictEqual(create, []);
  assert.deepStrictEqual(remove, ['лишняя']);
});

// Одна и та же папка приходит из разных выбранных веток, и стороны могут писать
// её имя по-разному. Точный Set считал их за две: mkdir уходил дважды,
// предпросмотр обещал лишнюю работу, откат сносил одну папку два раза.
test('planDirs не создаёт одну папку дважды из-за разного написания', () => {
  const r = planDirs(['Отчёты', 'отчёты', 'Отчёты/2024'], []);
  assert.deepStrictEqual(r.create, ['Отчёты', 'Отчёты/2024']);
});

test('planDirs не удаляет одну лишнюю папку дважды', () => {
  const r = planDirs([], ['Старое', 'старое']);
  assert.deepStrictEqual(r.remove, ['Старое']);
});
