'use strict';

const path = require('path');
const fsp = require('fs').promises;

const { planSync, detectMoves, planDirs } = require('./sync');
const { ciKey } = require('./paths');

// Тип узла на стороне root: 'dir' | 'file' | 'missing'.
async function statType(root, rel) {
  try {
    const st = await fsp.stat(path.join(root, rel));
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'missing';
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
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

// Из списка относительных путей оставляет те, что на стороне root — папки.
async function existingDirs(root, rels) {
  const types = await Promise.all(rels.map((rel) => statType(root, rel)));
  return rels.filter((_, i) => types[i] === 'dir');
}

// План для одной выбранной ветки (папки ИЛИ отдельного файла).
// Все пути в результате — от корня стороны, а не от ветки: только так виден
// перенос файла из одной выбранной ветки в другую.
// scan(root, branch, excludes) → { files, dirs } с путями относительно branch.
async function planForBranch(srcRoot, dstRoot, branch, excludes, scan) {
  const [srcType, dstType] = await Promise.all([
    statType(srcRoot, branch),
    statType(dstRoot, branch),
  ]);

  // Разные типы под одним именем: на источнике папка, на приёмнике файл (или
  // наоборот). Приёмник надо расчистить, и отдельным действием: readdir по файлу
  // рушил весь скан с ENOTDIR, а копирование файла поверх папки падало с EPERM.
  const conflict = !!branch && srcType !== 'missing' && dstType !== 'missing' && srcType !== dstType;
  const conflicts = conflict ? [branch] : [];

  if (srcType === 'file' || (srcType === 'missing' && dstType === 'file')) {
    // statEntry отдаёт null для папки, поэтому при конфликте приёмник и так
    // считается пустым — узел уберёт фаза конфликтов.
    const [srcE, dstE] = await Promise.all([
      statEntry(srcRoot, branch),
      statEntry(dstRoot, branch),
    ]);
    return {
      plan: planSync(srcE ? [srcE] : [], dstE ? [dstE] : []),
      srcDirs: [],
      dstDirs: [],
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
  const rebase = (entries) => entries.map((e) => ({ ...e, path: under(e.path) }));

  // Тот же конфликт типов, но в глубине ветки. Скан его переживает — типы он
  // читает из dirent на каждой стороне отдельно, — а вот план ломался: mkdir
  // упирался в файл, копирование ложилось поверх папки, и запуск заканчивался
  // горстью ошибок, которые расходились только со второго запуска.
  // Приёмник расчищаем целиком одним действием, поэтому всё, что лежало внутри
  // такого узла, из плана вычёркиваем: к моменту удаления по одному его уже нет.
  // Результат скана при этом не трогаем — он лежит в кеше и переживёт нас.
  const inner = findTypeConflicts(src, dst);
  const innerKeys = inner.map(ciKey);
  const covered = (rel) => {
    const k = ciKey(rel);
    return innerKeys.some((c) => k === c || k.startsWith(c + '/'));
  };
  const dstFiles = inner.length ? dst.files.filter((e) => !covered(e.path)) : dst.files;
  const dstDirs = inner.length ? dst.dirs.filter((d) => !covered(d)) : dst.dirs;
  appendAll(conflicts, inner.map(under));

  // Сама ветка — часть структуры: без неё пустая выбранная папка не создастся,
  // а лишняя не уберётся. Родителей же проверяем на каждой стороне отдельно:
  // ветки может не быть на источнике, а её родитель там есть, и тогда удалять
  // его на приёмнике нельзя — иначе с приёмника пропала бы живая папка.
  const parents = branch ? ancestorsOf(branch) : [];
  const self = branch ? [branch] : [];
  const [srcParents, dstParents] = await Promise.all([
    existingDirs(srcRoot, parents),
    existingDirs(dstRoot, parents),
  ]);

  return {
    plan: planSync(rebase(src.files), rebase(dstFiles)),
    srcDirs: [...srcParents, ...(srcType === 'dir' ? [...self, ...src.dirs.map(under)] : [])],
    dstDirs: [...dstParents, ...(dstType === 'dir' ? [...self, ...dstDirs.map(under)] : [])],
    conflicts,
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
  return { files, dirs };
}

// Дописывает items в конец target. Именно циклом, а не push(...items):
// спред раскладывает массив в аргументы вызова, а их число ограничено
// (около 125 тысяч), и на ветке в сотни тысяч файлов слияние планов падало
// с «Maximum call stack size exceeded» ещё до предпросмотра.
function appendAll(target, items) {
  for (const item of items) target.push(item);
}

// Один план на весь запуск: ветки объединяются, и только потом ищутся перемещения.
// Иначе перенос файла между двумя выбранными ветками остался бы незамеченным.
async function buildRunPlan(srcRoot, dstRoot, folders, excludes, scan) {
  const merged = { copy: [], overwrite: [], trash: [], unchanged: [] };
  const srcDirs = [];
  const dstDirs = [];
  const conflicts = [];

  for (const folder of folders) {
    const branch = await planForBranch(srcRoot, dstRoot, folder, excludes, scan);
    for (const key of Object.keys(merged)) appendAll(merged[key], branch.plan[key]);
    appendAll(srcDirs, branch.srcDirs);
    appendAll(dstDirs, branch.dstDirs);
    appendAll(conflicts, branch.conflicts);
  }

  const plan = detectMoves(merged);
  plan.dirs = planDirs(srcDirs, dstDirs);
  plan.conflicts = conflicts;
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
  // От длинных к коротким: первое совпадение и есть самая точная ветка.
  const bySpecificity = [...folders]
    .sort((a, b) => b.length - a.length)
    .map((f) => [f, ciKey(f)]);
  const bucketFor = (rel) => {
    const k = ciKey(rel);
    for (const [f, kf] of bySpecificity) if (k === kf || k.startsWith(kf + '/')) return counts.get(f);
    return null;
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
  const dirBucketFor = (rel) => {
    const direct = bucketFor(rel);
    if (direct) return direct;
    const prefix = ciKey(rel) + '/';
    for (const [f, kf] of bySpecificity) if (kf.startsWith(prefix)) return counts.get(f);
    return null;
  };
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
