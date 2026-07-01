'use strict';

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

module.exports = { pruneDescendants };
