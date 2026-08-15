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

function baseName(relPath) {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(slash + 1) : relPath;
}

// Основной ключ — размер и имя файла. Дата тут не в ключе намеренно: сетевые шары
// и FAT округляют её по-своему, и точное совпадение до миллисекунды по сети
// не срабатывает. Дату проверяем отдельно, с тем же допуском, что и везде.
function keyByName(entry) {
  return `${entry.size}:${baseName(entry.path)}`;
}

// Запасной ключ — для переноса, при котором файл ещё и переименовали. Имени нет,
// поэтому здесь дата обязана совпасть точно: без имени только она отличает
// действительно тот же файл от случайно одноразмерного чужого.
function keyByExactTime(entry) {
  return `${entry.size}:${Math.round(entry.mtimeMs)}`;
}

function groupBy(entries, keyOf) {
  const groups = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}

// Сводит пары там, где по ключу ровно один кандидат с каждой стороны.
// При нескольких одинаковых непонятно, что куда переложили, и они остаются
// нераспознанными — лучше лишний раз скопировать, чем перепутать файлы.
// sameFile(a, b) — последняя проверка перед тем, как признать пару переносом.
function pairUp(gone, added, keyOf, sameFile, moves) {
  const goneBy = groupBy(gone, keyOf);
  const addedBy = groupBy(added, keyOf);
  const taken = new Set();

  for (const [key, from] of goneBy) {
    const to = addedBy.get(key);
    if (!to || from.length !== 1 || to.length !== 1) continue;
    if (!sameFile(to[0], from[0])) continue;
    moves.push({ from: from[0].path, to: to[0].path, path: to[0].path, size: to[0].size });
    taken.add(from[0].path);
    taken.add(to[0].path);
  }

  return {
    gone: gone.filter((e) => !taken.has(e.path)),
    added: added.filter((e) => !taken.has(e.path)),
  };
}

// Выделяет из плана перемещения: то, что иначе ушло бы в trash и заново
// скопировалось бы по новому пути.
// Пути в плане должны быть от общего корня, иначе перенос между выбранными
// ветками не будет виден.
function detectMoves(plan) {
  const moves = [];
  // Первый проход: имя сохранилось. Так выглядит перенос файла и переименование
  // папки — самые частые случаи.
  const first = pairUp(plan.trash, plan.copy, keyByName, (src, dst) => !isChanged(src, dst), moves);
  // Второй проход: файл ещё и переименовали. Требование точной даты делает его
  // осторожным — по сети он просто не сработает, и файл поедет обычным копированием.
  const rest = pairUp(first.gone, first.added, keyByExactTime, () => true, moves);

  return { ...plan, moves, copy: rest.added, trash: rest.gone };
}

// Какие папки создать на приёмнике и какие с него убрать, чтобы структура совпала.
// Удаление идёт от глубоких к мелким, поэтому обратная сортировка.
function planDirs(srcDirs, dstDirs) {
  const src = new Set(srcDirs);
  const dst = new Set(dstDirs);
  return {
    create: [...new Set(srcDirs)].filter((d) => !dst.has(d)).sort(),
    remove: [...new Set(dstDirs)].filter((d) => !src.has(d)).sort().reverse(),
  };
}

// Сводка плана для окна предпросмотра.
function summarize(plan) {
  const moves = plan.moves ? plan.moves.length : 0;
  const dirs = plan.dirs ? plan.dirs.create.length + plan.dirs.remove.length : 0;
  return {
    move: moves,
    copy: plan.copy.length,
    overwrite: plan.overwrite.length,
    trash: plan.trash.length,
    unchanged: plan.unchanged.length,
    dirs,
    total: moves + plan.copy.length + plan.overwrite.length + plan.trash.length + dirs,
  };
}

module.exports = {
  planSync,
  detectMoves,
  planDirs,
  summarize,
  isChanged,
  MTIME_TOLERANCE_MS,
};
