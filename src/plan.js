'use strict';

const path = require('path');
const fsp = require('fs').promises;

const { planSync, detectMoves, planDirs } = require('./sync');

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

  if (srcType === 'file' || (srcType === 'missing' && dstType === 'file')) {
    const [srcE, dstE] = await Promise.all([
      statEntry(srcRoot, branch),
      statEntry(dstRoot, branch),
    ]);
    return {
      plan: planSync(srcE ? [srcE] : [], dstE ? [dstE] : []),
      srcDirs: [],
      dstDirs: [],
    };
  }

  const [src, dst] = await Promise.all([
    scan(srcRoot, branch, excludes),
    scan(dstRoot, branch, excludes),
  ]);
  const under = (rel) => (branch ? `${branch}/${rel}` : rel);
  const rebase = (entries) => entries.map((e) => ({ ...e, path: under(e.path) }));

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
    plan: planSync(rebase(src.files), rebase(dst.files)),
    srcDirs: [...srcParents, ...(srcType === 'dir' ? [...self, ...src.dirs.map(under)] : [])],
    dstDirs: [...dstParents, ...(dstType === 'dir' ? [...self, ...dst.dirs.map(under)] : [])],
  };
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

  for (const folder of folders) {
    const branch = await planForBranch(srcRoot, dstRoot, folder, excludes, scan);
    for (const key of Object.keys(merged)) appendAll(merged[key], branch.plan[key]);
    appendAll(srcDirs, branch.srcDirs);
    appendAll(dstDirs, branch.dstDirs);
  }

  const plan = detectMoves(merged);
  plan.dirs = planDirs(srcDirs, dstDirs);
  return plan;
}

// Счётчики по каждой выбранной ветке — для списка в окне предпросмотра.
// Ветки после pruneDescendants не вложены друг в друга, поэтому путь принадлежит
// не более чем одной из них.
function countByFolder(plan, folders) {
  const blank = () => ({ move: 0, copy: 0, overwrite: 0, trash: 0, unchanged: 0, dirs: 0, total: 0 });
  const counts = new Map(folders.map((f) => [f, blank()]));
  const bucketFor = (rel) => {
    for (const f of folders) if (rel === f || rel.startsWith(f + '/')) return counts.get(f);
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
  for (const rel of [...plan.dirs.create, ...plan.dirs.remove]) {
    const bucket = bucketFor(rel);
    if (bucket) bucket.dirs += 1;
  }
  for (const bucket of counts.values()) {
    bucket.total = bucket.move + bucket.copy + bucket.overwrite + bucket.trash + bucket.dirs;
  }
  return folders.map((folder) => ({ folder, summary: counts.get(folder) }));
}

module.exports = { buildRunPlan, planForBranch, countByFolder, statType, ancestorsOf };
