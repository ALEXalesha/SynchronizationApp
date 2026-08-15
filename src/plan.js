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
  // Сама ветка и её родители — тоже часть структуры: без них пустая выбранная
  // папка не создастся, а лишняя не уберётся.
  const selfAndParents = branch ? [...ancestorsOf(branch), branch] : [];

  return {
    plan: planSync(rebase(src.files), rebase(dst.files)),
    srcDirs: srcType === 'dir' ? [...selfAndParents, ...src.dirs.map(under)] : [],
    dstDirs: dstType === 'dir' ? [...selfAndParents, ...dst.dirs.map(under)] : [],
  };
}

// Один план на весь запуск: ветки объединяются, и только потом ищутся перемещения.
// Иначе перенос файла между двумя выбранными ветками остался бы незамеченным.
async function buildRunPlan(srcRoot, dstRoot, folders, excludes, scan) {
  const merged = { copy: [], overwrite: [], trash: [], unchanged: [] };
  const srcDirs = [];
  const dstDirs = [];

  for (const folder of folders) {
    const branch = await planForBranch(srcRoot, dstRoot, folder, excludes, scan);
    for (const key of Object.keys(merged)) merged[key].push(...branch.plan[key]);
    srcDirs.push(...branch.srcDirs);
    dstDirs.push(...branch.dstDirs);
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
