'use strict';

// Чистая логика планирования синхронизации.
// Никаких файловых операций — только сравнение двух списков записей.
//
// Запись файла (FileEntry):
//   { path: 'sub/dir/file.txt', size: 123, mtimeMs: 1719900000000 }
// path — путь относительно корня выбранной папки, разделитель '/'.

// Порог различия времени в миллисекундах. Разные файловые системы (NTFS, сеть)
// округляют mtime по-разному, поэтому небольшую дельту считаем «одинаковым».
const MTIME_TOLERANCE_MS = 2000;

function indexByPath(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.path, e);
  return map;
}

function isChanged(src, dst) {
  if (src.size !== dst.size) return true;
  return Math.abs(src.mtimeMs - dst.mtimeMs) > MTIME_TOLERANCE_MS;
}

// Строит план приведения приёмника к копии источника.
// Возвращает:
//   {
//     copy:      [FileEntry]  — есть в источнике, нет в приёмнике,
//     overwrite: [FileEntry]  — есть в обоих, но отличаются,
//     trash:     [FileEntry]  — есть в приёмнике, нет в источнике (в Корзину),
//     unchanged: [FileEntry]  — совпадают,
//   }
function planSync(sourceEntries, destEntries) {
  const srcIndex = indexByPath(sourceEntries);
  const dstIndex = indexByPath(destEntries);

  const copy = [];
  const overwrite = [];
  const trash = [];
  const unchanged = [];

  for (const src of sourceEntries) {
    const dst = dstIndex.get(src.path);
    if (!dst) {
      copy.push(src);
    } else if (isChanged(src, dst)) {
      overwrite.push(src);
    } else {
      unchanged.push(src);
    }
  }

  for (const dst of destEntries) {
    if (!srcIndex.has(dst.path)) trash.push(dst);
  }

  return { copy, overwrite, trash, unchanged };
}

// Сводка плана для окна предпросмотра.
function summarize(plan) {
  return {
    copy: plan.copy.length,
    overwrite: plan.overwrite.length,
    trash: plan.trash.length,
    unchanged: plan.unchanged.length,
    total: plan.copy.length + plan.overwrite.length + plan.trash.length,
  };
}

module.exports = { planSync, summarize, isChanged, MTIME_TOLERANCE_MS };
