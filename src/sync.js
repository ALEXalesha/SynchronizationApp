'use strict';

// Чистая логика планирования синхронизации.
// Никаких файловых операций — только сравнение двух списков записей.
//
// Запись файла (FileEntry):
//   { path: 'sub/dir/file.txt', size: 123, mtimeMs: 1719900000000 }
// path — путь относительно корня выбранной папки, разделитель '/'.

const { ciKey } = require('./paths');

// Порог различия времени в миллисекундах. Разные файловые системы (NTFS, сеть)
// округляют mtime по-разному, поэтому небольшую дельту считаем «одинаковым».
const MTIME_TOLERANCE_MS = 2000;

// Индекс по пути без учёта регистра: стороны сравниваются так же, как их
// сравнивает сама файловая система.
function indexByPath(entries) {
  const map = new Map();
  for (const e of entries) map.set(ciKey(e.path), e);
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
    const dst = dstIndex.get(ciKey(src.path));
    if (!dst) {
      copy.push(src);
    } else if (baseName(src.path) !== baseName(dst.path) || isChanged(src, dst)) {
      // Имена совпали, но написаны по-разному ('Note.txt' против 'note.txt') —
      // перезаписываем даже при одинаковом содержимом. Перезапись начинается
      // с переноса оригинала в служебную папку, поэтому на месте остаётся файл
      // с именем источника, а не старое написание.
      //
      // Сравниваем только имя файла, а не весь путь. Написание папки-предка
      // ('a0/n0.txt' против 'A0/n0.txt') этим способом не чинится: папку никто
      // не переименовывает, а planDirs считает оба написания одной и той же
      // и ничего не создаёт. Разница оставалась навсегда, и файл попадал
      // в перезапись на каждом запуске — вечный круг: предпросмотр обещал работу,
      // работа выполнялась, следующий предпросмотр обещал ровно ту же. По сети
      // это ещё и перекачка целых веток на каждом прогоне.
      overwrite.push(src);
    } else {
      unchanged.push(src);
    }
  }

  for (const dst of destEntries) {
    if (!srcIndex.has(ciKey(dst.path))) trash.push(dst);
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
  return `${entry.size}:${ciKey(baseName(entry.path))}`;
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
    // gone/added — исходные записи пары. Пара пока лишь кандидат: имя, размер
    // и дата совпадают у разных файлов чаще, чем кажется, и решает сверка
    // содержимого уже в планировщике. Не подтвердится — из этих двух записей
    // и собирается обратно обычная пара «скопировать + выбросить».
    moves.push({
      from: from[0].path,
      to: to[0].path,
      path: to[0].path,
      size: to[0].size,
      gone: from[0],
      added: to[0],
    });
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
//
// Пара признаётся переносом только при совпадении имени. Раньше был и второй
// проход — без имени, по одному лишь «размер + дата до миллисекунды». Он тихо
// портил данные: удалённый на приёмнике файл и новый на источнике случайно
// совпадают такой парой чаще, чем кажется (распаковка архива, git checkout,
// robocopy проставляют одинаковые метки времени пачкой). Приёмник получал
// содержимое чужого файла, отчёт показывал «Готово», а следующий запуск разницы
// уже не видел: rename сохранил дату, и файлы выглядели одинаковыми.
// Перенос с одновременным переименованием теперь идёт обычным копированием —
// медленнее, зато с верным содержимым.
//
// Совпадения имени этому мало: два разных config.json по 512 байт, записанных
// одной распаковкой, проходят проверку целиком. Поэтому здесь только кандидаты,
// а последнее слово за сверкой содержимого в confirmMoves.
function detectMoves(plan) {
  const moves = [];
  const rest = pairUp(plan.trash, plan.copy, keyByName, (src, dst) => !isChanged(src, dst), moves);
  return { ...plan, moves, copy: rest.added, trash: rest.gone };
}

// Убирает повторы без учёта регистра, сохраняя первое написание.
// Одна и та же папка приходит сюда из разных выбранных веток (для 'a/b/c'
// в список попадают и родители 'a', 'a/b'), а стороны могут писать её имя
// по-разному. Точный Set считал 'Docs' и 'docs' за две разные папки: mkdir
// уходил дважды, предпросмотр обещал лишнюю работу, а откат пытался снести
// одну и ту же папку два раза.
function uniqueDirs(dirs) {
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const k = ciKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

// Какие папки создать на приёмнике и какие с него убрать, чтобы структура совпала.
// Удаление идёт от глубоких к мелким, поэтому обратная сортировка.
// Сравнение без учёта регистра: иначе папка 'Docs' на приёмнике считалась лишней
// рядом с 'docs' на источнике, и её сносило rmdir сразу после создания.
function planDirs(srcDirs, dstDirs) {
  const src = new Set(srcDirs.map(ciKey));
  const dst = new Set(dstDirs.map(ciKey));
  return {
    create: uniqueDirs(srcDirs).filter((d) => !dst.has(ciKey(d))).sort(),
    remove: uniqueDirs(dstDirs).filter((d) => !src.has(ciKey(d))).sort().reverse(),
  };
}

// Сводка плана для окна предпросмотра.
// Конфликты типа (на источнике папка, на приёмнике файл с тем же именем, или
// наоборот) считаем удалением: с приёмника узел действительно убирается.
function summarize(plan) {
  const moves = plan.moves ? plan.moves.length : 0;
  const dirs = plan.dirs ? plan.dirs.create.length + plan.dirs.remove.length : 0;
  const trash = plan.trash.length + (plan.conflicts ? plan.conflicts.length : 0);
  return {
    move: moves,
    copy: plan.copy.length,
    overwrite: plan.overwrite.length,
    trash,
    unchanged: plan.unchanged.length,
    dirs,
    total: moves + plan.copy.length + plan.overwrite.length + trash + dirs,
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
