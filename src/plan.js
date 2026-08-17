'use strict';

const path = require('path');
const fsp = require('fs').promises;

const { planSync, detectMoves, planDirs } = require('./sync');
const { sameContent, runPool, APPLY_CONCURRENCY } = require('./fsops');
const { ciKey } = require('./paths');

// Тип узла на стороне root: 'dir' | 'file' | 'missing'.
// ENOTDIR — это путь, у которого один из предков файл. Узла там нет так же
// надёжно, как при ENOENT (Windows и вовсе отвечает вторым на первое), а разбирать
// предка — не дело stat: этим занимается фаза конфликтов.
async function statType(root, rel) {
  try {
    const st = await fsp.stat(path.join(root, rel));
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'missing';
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

async function statEntry(root, rel) {
  try {
    const st = await fsp.stat(path.join(root, rel));
    if (!st.isFile()) return null;
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Цепочка родителей ветки: 'a/b/c' → ['a', 'a/b'].
// Нужна, чтобы создание вложенной ветки было полностью описано планом,
// а не оставляло следов при откате.
function ancestorsOf(branch) {
  const parts = branch.split('/');
  const out = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

// Типы списка относительных путей на стороне root, в том же порядке.
async function typesOf(root, rels) {
  return Promise.all(rels.map((rel) => statType(root, rel)));
}

// План для одной выбранной ветки (папки ИЛИ отдельного файла).
// Все пути в результате — от корня стороны, а не от ветки: только так виден
// перенос файла из одной выбранной ветки в другую.
// scan(root, branch, excludes) → { files, dirs } с путями относительно branch.
async function planForBranch(srcRoot, dstRoot, branch, excludes, scan) {
  // Родителей проверяем на каждой стороне отдельно: ветки может не быть
  // на источнике, а её родитель там есть, и тогда удалять его на приёмнике
  // нельзя — иначе с приёмника пропала бы живая папка.
  const parents = branch ? ancestorsOf(branch) : [];
  const [srcType, dstType, srcParentTypes, dstParentTypes] = await Promise.all([
    statType(srcRoot, branch),
    statType(dstRoot, branch),
    typesOf(srcRoot, parents),
    typesOf(dstRoot, parents),
  ]);
  const srcParents = parents.filter((_, i) => srcParentTypes[i] === 'dir');
  const dstParents = parents.filter((_, i) => dstParentTypes[i] === 'dir');

  // Предок ветки, который на источнике папка, а на приёмнике файл. Внутрь такого
  // узла не проходит ничего: mkdir отвечает EEXIST, копирование — ENOTDIR, и так
  // на каждом запуске. Ветка молча не синхронизировалась никогда, а отчёт показывал
  // горсть ошибок с путями, которых на приёмнике вообще нет. Убираем его той же
  // фазой конфликтов, что и остальные несовпадения типов.
  const conflicts = parents.filter(
    (_, i) => srcParentTypes[i] === 'dir' && dstParentTypes[i] === 'file'
  );

  // Тот же конфликт, но на самой ветке: на источнике папка, на приёмнике файл
  // (или наоборот). Приёмник надо расчистить, и отдельным действием: readdir
  // по файлу рушил весь скан с ENOTDIR, а копирование файла поверх папки падало
  // с EPERM.
  if (branch && srcType !== 'missing' && dstType !== 'missing' && srcType !== dstType) {
    conflicts.push(branch);
  }

  if (srcType === 'file' || (srcType === 'missing' && dstType === 'file')) {
    // statEntry отдаёт null для папки, поэтому при конфликте приёмник и так
    // считается пустым — узел уберёт фаза конфликтов.
    const [srcE, dstE] = await Promise.all([
      statEntry(srcRoot, branch),
      statEntry(dstRoot, branch),
    ]);
    return {
      plan: planSync(srcE ? [srcE] : [], dstE ? [dstE] : []),
      srcDirs: srcParents,
      dstDirs: dstParents,
      conflicts,
    };
  }

  // Сторону, которая не папка, не сканируем: readdir по файлу бросает ENOTDIR
  // и обрывает предпросмотр целиком.
  const [src, dst] = await Promise.all([
    srcType === 'dir' ? scan(srcRoot, branch, excludes) : { files: [], dirs: [] },
    dstType === 'dir' ? scan(dstRoot, branch, excludes) : { files: [], dirs: [] },
  ]);
  const under = (rel) => (branch ? `${branch}/${rel}` : rel);
  // Корень ветки скан отдаёт пустой строкой — путём от корня она и есть ветка.
  const underPath = (rel) => (rel === '' ? branch || '' : under(rel));
  const rebase = (entries) => entries.map((e) => ({ ...e, path: under(e.path) }));

  // Папки, закрытые правами хотя бы на одной стороне. Внутрь такого узла не видно,
  // и сравнивать там нечего — содержимое выбрасываем из плана на ОБЕИХ сторонах
  // разом. Порознь нельзя: закрытая ветка на источнике читалась бы как пустая,
  // а пустой источник означает «на приёмнике всё лишнее», и одна ошибка прав
  // стирала бы с приёмника живую ветку целиком. Сам узел тоже выбывает: он
  // существует, просто заглянуть в него не дают, — значит ни создавать его,
  // ни сносить не нужно.
  const skipped = topPaths([...(src.skipped || []), ...(dst.skipped || [])]);
  // Сам названный путь тоже вне сравнения, не только его содержимое. Закрытым
  // может оказаться не папка, а отдельный файл: скан отдаёт его этим же списком,
  // потому что размера он не знает. Проверялись только вложенные пути, и такой
  // файл не отсекал сам себя — на приёмнике копия выглядела лишней и уезжала
  // в Корзину. Для папки разница безобидна: закрытый узел просто не создаётся
  // на пустом месте и не сносится с приёмника, а этого и надо.
  const blind = underAny(skipped);
  const seen = (side) =>
    skipped.length
      ? { files: side.files.filter((e) => !blind(e.path)), dirs: side.dirs.filter((d) => !blind(d)) }
      : side;
  const srcSeen = seen(src);
  const dstSeen = seen(dst);

  // Тот же конфликт типов, но в глубине ветки. Скан его переживает — типы он
  // читает из dirent на каждой стороне отдельно, — а вот план ломался: mkdir
  // упирался в файл, копирование ложилось поверх папки, и запуск заканчивался
  // горстью ошибок, которые расходились только со второго запуска.
  // Приёмник расчищаем целиком одним действием, поэтому всё, что лежало внутри
  // такого узла, из плана вычёркиваем: к моменту удаления по одному его уже нет.
  // Результат скана при этом не трогаем — он лежит в кеше и переживёт нас.
  const inner = findTypeConflicts(srcSeen, dstSeen);
  const covered = underAny(inner);
  const dstFiles = inner.length ? dstSeen.files.filter((e) => !covered(e.path)) : dstSeen.files;
  const dstDirs = inner.length ? dstSeen.dirs.filter((d) => !covered(d)) : dstSeen.dirs;
  appendAll(conflicts, inner.map(under));

  // Сама ветка — часть структуры: без неё пустая выбранная папка не создастся,
  // а лишняя не уберётся.
  const self = branch ? [branch] : [];

  return {
    plan: planSync(rebase(srcSeen.files), rebase(dstFiles)),
    srcDirs: [...srcParents, ...(srcType === 'dir' ? [...self, ...srcSeen.dirs.map(under)] : [])],
    dstDirs: [...dstParents, ...(dstType === 'dir' ? [...self, ...dstDirs.map(under)] : [])],
    conflicts,
    skipped: skipped.map(underPath),
  };
}

// Узлы, которые на источнике папка, а на приёмнике файл (или наоборот).
// Пути — относительно ветки, как их отдал скан.
function findTypeConflicts(src, dst) {
  const out = [];
  if (src.files.length === 0 && src.dirs.length === 0) return out;
  const dstFileSet = new Set(dst.files.map((e) => ciKey(e.path)));
  const dstDirSet = new Set(dst.dirs.map(ciKey));
  for (const d of src.dirs) if (dstFileSet.has(ciKey(d))) out.push(d);
  for (const e of src.files) if (dstDirSet.has(ciKey(e.path))) out.push(e.path);
  return out;
}

// Файлы и папки ветки из готового индекса обхода (пути — относительно ветки).
// idx — { files: Map(rel → {size, mtimeMs}), dirs: Set(rel) } с путями от корня стороны.
//
// Исключения учитываем только те, что лежат внутри самой ветки. Снять отметку
// с 'docs/a', а потом вернуть её вложенной части 'docs/a/b' — законный выбор:
// тогда выбраны и 'docs', и 'docs/a/b', а исключено 'docs/a'. Для ветки
// 'docs/a/b' запрет с 'docs/a' уже не действует — самая точная отметка главнее.
// Живой скан так и работает: ему отдают исключения, пересчитанные относительно
// ветки, и 'docs/a' до него просто не доходит. Индекс же сравнивал полные пути
// и выбрасывал всю вложенную ветку целиком — молча, без единой ошибки, и только
// когда фоновый обход успел досчитаться. Один и тот же выбор давал разный
// результат в зависимости от того, включены ли размеры.
//
// Регистр в сравнении не участвует. Ветку интерфейс берёт из общего списка обеих
// сторон, а имя в нём — с той стороны, что попала в список первой. Если вторая
// пишет ту же папку иначе ('Docs' против 'docs'), точное сравнение не находило
// в индексе ни одного пути: сторона читалась пустой. Пустой источник означает
// «на приёмнике всё лишнее», и план предлагал стереть ветку целиком.
function scanFromIndex(idx, branch, excludes) {
  const prefix = branch ? `${branch}/` : '';
  const pfx = ciKey(prefix);
  // Сравниваем ровно ту часть пути, что займёт префикс: срезать всё равно
  // придётся по длине исходной строки, а не приведённой.
  const underBranch = (rel) =>
    prefix === '' || (rel.length > prefix.length && ciKey(rel.slice(0, prefix.length)) === pfx);

  const branchKey = ciKey(branch || '');
  const inner = [...excludes]
    .map(ciKey)
    .filter((ex) => ex !== branchKey && ex.startsWith(pfx));
  const excluded = (rel) => {
    const k = ciKey(rel);
    return inner.some((ex) => k === ex || k.startsWith(`${ex}/`));
  };

  const files = [];
  const dirs = [];
  for (const [rel, meta] of idx.files) {
    if (!underBranch(rel) || excluded(rel)) continue;
    files.push({ path: rel.slice(prefix.length), size: meta.size, mtimeMs: meta.mtimeMs });
  }
  for (const rel of idx.dirs) {
    if (!underBranch(rel) || excluded(rel)) continue;
    dirs.push(rel.slice(prefix.length));
  }
  // Закрытые правами папки обход тоже запоминает, и отдать их надо ровно так же,
  // как это делает живой скан: планировщик обязан вести себя одинаково независимо
  // от того, включён подсчёт размеров или нет. Разойдись эти два пути — один
  // и тот же выбор давал бы разный результат, а такую разницу пользователю
  // ни увидеть, ни объяснить.
  const skipped = [];
  for (const rel of idx.skipped || []) {
    // Закрыт сам корень ветки — живой скан обозначает это пустой строкой,
    // потому что он и стартует изнутри ветки. Индекс же держит полные пути.
    if (ciKey(rel) === branchKey) {
      skipped.push('');
      continue;
    }
    if (!underBranch(rel) || excluded(rel)) continue;
    skipped.push(rel.slice(prefix.length));
  }
  return { files, dirs, skipped };
}

// Дописывает items в конец target. Именно циклом, а не push(...items):
// спред раскладывает массив в аргументы вызова, а их число ограничено
// (около 125 тысяч), и на ветке в сотни тысяч файлов слияние планов падало
// с «Maximum call stack size exceeded» ещё до предпросмотра.
function appendAll(target, items) {
  for (const item of items) target.push(item);
}

// Есть ли в keys сам путь k или любой его предок. Подъёмом по пути, а не перебором
// keys: перебор стоил произведения двух пределов, и оба выросли до законных величин.
// Ключи уже приведены к нижнему регистру, k тоже.
function coveredByKey(keys, k) {
  let cur = k;
  for (;;) {
    if (keys.has(cur)) return true;
    const slash = cur.lastIndexOf('/');
    if (slash < 0) return false;
    cur = cur.slice(0, slash);
  }
}

// Готовит проверку «путь лежит внутри одного из названных узлов (или сам им является)».
//
// Раньше это был перебор всего списка на каждый путь ветки, и два предела
// перемножались. Список закрытых правами узлов считался коротким — «закрытая папка
// даёт одну запись, внутрь не спускаемся», — но с тех пор в него попадают и отдельные
// файлы, у которых не читается даже размер: шара, где папку листать дают, а stat
// по файлам нет, отдаёт запись на каждый файл. Тысяча таких записей на ветку
// в 50 тысяч файлов — десять секунд замершего главного процесса ровно между
// сканом и появлением предпросмотра, и это ещё на каждую выбранную ветку отдельно.
// Подъём по пути стоит глубины пути, а она измеряется единицами.
function underAny(paths) {
  const keys = new Set();
  for (const p of paths) {
    const k = ciKey(p);
    // Пустой ключ — назван сам корень ветки: не видно вообще ничего.
    if (k === '') return () => true;
    keys.add(k);
  }
  if (keys.size === 0) return () => false;
  return (rel) => coveredByKey(keys, ciKey(rel));
}

// Оставляет только верхние узлы списка: без повторов и без вложенных.
// Для конфликтов это обязательно: общий предок двух выбранных веток приходит
// сюда дважды, а конфликт в глубине ветки может оказаться внутри конфликтного
// предка. Узел уезжает в служебную папку целиком, поэтому второй заход по тому же
// месту нашёл бы там пусто — и записал бы в отчёт файл, удалённый безвозвратно,
// хотя он цел. Для закрытых правами папок — та же логика: показывать пользователю
// вложенные пути внутри уже названной закрытой ветки незачем.
// Сортировка по длине ставит предка раньше потомка, поэтому к моменту проверки
// потомка предок уже в наборе. Проверяем подъёмом по пути, а не перебором набора:
// закрытых правами узлов может быть не единицы, а тысячи (см. underAny).
function topPaths(paths) {
  const kept = [];
  const keys = new Set();
  for (const rel of [...paths].sort((a, b) => a.length - b.length)) {
    const k = ciKey(rel);
    if (coveredByKey(keys, k)) continue;
    kept.push(rel);
    keys.add(k);
  }
  return kept;
}

// Сверяет кандидатов в перемещения по содержимому и разворачивает непрошедших
// обратно в «скопировать + выбросить».
//
// Кандидат — пара «пропал на приёмнике / появился на источнике» с одинаковым
// именем, размером и датой. Этого мало: два разных файла с общим именем
// и размером получают одинаковую дату пачкой при распаковке архива, git checkout
// и robocopy. Приёмник переименовывал свой старый файл в новый путь и получал
// чужое содержимое, а следующий запуск разницы уже не видел — имя, размер и дата
// сходились. Тихая порча, которую нельзя было заметить изнутри приложения.
//
// Читаем края, а не файл целиком: перемещение затем и распознаётся, что стоит
// одного rename, и сверка не должна обходиться дороже самого копирования.
async function confirmMoves(srcRoot, dstRoot, plan) {
  if (plan.moves.length === 0) return;
  const verdicts = new Array(plan.moves.length);
  const idx = plan.moves.map((_, i) => i);
  await runPool(idx, APPLY_CONCURRENCY, async (i) => {
    const mv = plan.moves[i];
    verdicts[i] = await sameContent(
      path.join(srcRoot, mv.to),
      path.join(dstRoot, mv.from)
    ).catch(() => false);
  });

  const confirmed = [];
  for (let i = 0; i < plan.moves.length; i += 1) {
    const mv = plan.moves[i];
    if (verdicts[i]) {
      confirmed.push(mv);
      continue;
    }
    plan.copy.push(mv.added);
    plan.trash.push(mv.gone);
  }
  plan.moves = confirmed;
}

// Один план на весь запуск: ветки объединяются, и только потом ищутся перемещения.
// Иначе перенос файла между двумя выбранными ветками остался бы незамеченным.
async function buildRunPlan(srcRoot, dstRoot, folders, excludes, scan) {
  const merged = { copy: [], overwrite: [], trash: [], unchanged: [] };
  const srcDirs = [];
  const dstDirs = [];
  const conflicts = [];
  const skipped = [];

  for (const folder of folders) {
    const branch = await planForBranch(srcRoot, dstRoot, folder, excludes, scan);
    for (const key of Object.keys(merged)) appendAll(merged[key], branch.plan[key]);
    appendAll(srcDirs, branch.srcDirs);
    appendAll(dstDirs, branch.dstDirs);
    appendAll(conflicts, branch.conflicts);
    appendAll(skipped, branch.skipped || []);
  }

  const plan = detectMoves(merged);
  await confirmMoves(srcRoot, dstRoot, plan);
  plan.dirs = planDirs(srcDirs, dstDirs);
  plan.conflicts = topPaths(conflicts);
  // Закрытые правами папки в план работ не входят, но пользователю о них сказать
  // обязаны: иначе ветка молча не синхронизируется, а отчёт рапортует «Готово».
  plan.skipped = topPaths(skipped);
  return plan;
}

// Счётчики по каждой выбранной ветке — для списка в окне предпросмотра.
// Ветки могут быть вложены друг в друга: снять отметку с подпапки, а потом
// вернуть её вложенной части — законный сценарий, и тогда выбраны и 'docs',
// и 'docs/a/b'. Путь засчитываем самой длинной подходящей ветке, иначе вся
// работа вложенной ветки утекала бы в родителя, а сама она показывала бы
// «без изменений».
function countByFolder(plan, folders) {
  const blank = () => ({ move: 0, copy: 0, overwrite: 0, trash: 0, unchanged: 0, dirs: 0, total: 0 });
  const counts = new Map(folders.map((f) => [f, blank()]));
  // Ветку ищем подъёмом по пути, а не перебором всех веток на каждый путь.
  // Перебор стоил произведения, и оба предела перемножались: «Выбрать все» на
  // папке с тысячами узлов верхнего уровня — законный сценарий (отметки живут
  // отдельно от строк и покрывают даже непоказанные), и 5000 веток на 100 тысяч
  // файлов давали секунды замершего главного процесса ровно между сканом
  // и появлением предпросмотра. Первое совпадение при подъёме — самая длинная
  // подходящая ветка, то же, что давал перебор от длинных к коротким.
  const byKey = new Map();
  for (const f of folders) {
    const k = ciKey(f);
    if (!byKey.has(k)) byKey.set(k, counts.get(f));
  }
  const bucketFor = (rel) => {
    let k = ciKey(rel);
    for (;;) {
      const hit = byKey.get(k);
      if (hit) return hit;
      const slash = k.lastIndexOf('/');
      if (slash < 0) return null;
      k = k.slice(0, slash);
    }
  };

  // Перемещения лежат в plan.moves, остальное — под своим же именем.
  const listFor = (key) => (key === 'move' ? plan.moves : plan[key]) || [];
  for (const key of ['move', 'copy', 'overwrite', 'trash', 'unchanged']) {
    for (const e of listFor(key)) {
      const bucket = bucketFor(e.path);
      if (bucket) bucket[key] += 1;
    }
  }
  for (const rel of plan.conflicts || []) {
    const bucket = bucketFor(rel);
    if (bucket) bucket.trash += 1;
  }
  // Папки считаем чуть шире: кроме вложенных в ветку, к ней относятся и её
  // собственные родители. Для ветки 'a/b/c' план создаёт ещё 'a' и 'a/b',
  // а внутрь 'a/b/c' они не вложены — bucketFor их не находил. В шапке они были,
  // в списке по веткам нет, и сумма по строкам не сходилась с итогом.
  // Цепочки родителей размечаем разом, а не подбирая ветку под каждую папку:
  // перебором это стоило веток на папки, и на пяти тысячах отмеченных веток
  // выходило дороже самого прохода по файлам. Ветки берём от длинных к коротким
  // и первую занявшую предка не перебиваем — тот же выбор, что и у перебора.
  const ownerOfParent = new Map();
  for (const f of [...folders].sort((a, b) => b.length - a.length)) {
    let k = ciKey(f);
    for (;;) {
      const slash = k.lastIndexOf('/');
      if (slash < 0) break;
      k = k.slice(0, slash);
      if (ownerOfParent.has(k)) break; // выше уже размечено этой же цепочкой
      ownerOfParent.set(k, counts.get(f));
    }
  }
  const dirBucketFor = (rel) => bucketFor(rel) || ownerOfParent.get(ciKey(rel)) || null;
  for (const rel of [...plan.dirs.create, ...plan.dirs.remove]) {
    const bucket = dirBucketFor(rel);
    if (bucket) bucket.dirs += 1;
  }
  for (const bucket of counts.values()) {
    bucket.total = bucket.move + bucket.copy + bucket.overwrite + bucket.trash + bucket.dirs;
  }
  return folders.map((folder) => ({ folder, summary: counts.get(folder) }));
}

module.exports = {
  buildRunPlan,
  planForBranch,
  countByFolder,
  scanFromIndex,
  statType,
  ancestorsOf,
};
