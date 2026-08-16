'use strict';

const path = require('path');

// Ключ для сравнения путей двух сторон. Регистр не значим: NTFS и сетевые шары
// не различают 'Docs' и 'docs', поэтому сравнение через === выдавало один и тот же
// файл за два разных. Приёмник получал копию поверх своего же файла, а следом
// исходное имя уезжало в Корзину — и файл пропадал с приёмника целиком.
// toLowerCase, а не toLocaleLowerCase: локаль пользователя не должна влиять
// на то, совпали пути или нет.
function ciKey(p) {
  return p.toLowerCase();
}

// Лежит ли inner внутри outer (или это тот же путь).
// Регистр не важен: на Windows пути к нему нечувствительны.
function isInside(inner, outer) {
  const a = path.resolve(inner).toLowerCase();
  const b = path.resolve(outer).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// Пересекаются ли корни синхронизации: один внутри другого или это одна папка.
// Такая пара — копирование папки внутрь самой себя: приёмник по ходу работы
// растёт, и уже скопированное снова выглядит новым.
function rootsOverlap(srcRoot, dstRoot) {
  return isInside(srcRoot, dstRoot) || isInside(dstRoot, srcRoot);
}

// Из набора выбранных путей папок убирает те, что вложены в другой выбранный путь.
// Если выбраны и 'docs', и 'docs/2024' — синхронизация 'docs' уже покрывает вложенное,
// поэтому оставляем только 'docs'. Пути с разделителем '/'.
function pruneDescendants(paths) {
  const sorted = [...new Set(paths)].sort();
  const result = [];
  for (const p of sorted) {
    const covered = result.some((r) => p === r || p.startsWith(r + '/'));
    if (!covered) result.push(p);
  }
  return result;
}

module.exports = { pruneDescendants, isInside, rootsOverlap, ciKey };
