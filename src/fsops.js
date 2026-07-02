'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Рекурсивно собирает список файлов внутри dir.
// Возвращает массив записей { path, size, mtimeMs }, path — относительный,
// с разделителем '/'. Символические ссылки пропускаются (не ходим по ним).
// excludes — Set путей папок (относительно dir), которые нужно пропустить целиком.
async function scanFiles(dir, rel = '', out = [], excludes = null) {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out; // папки нет — пустой список
    throw err;
  }

  for (const dirent of dirents) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (excludes && excludes.has(childRel)) continue; // исключённая ветка
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      await scanFiles(dir, childRel, out, excludes);
    } else if (dirent.isFile()) {
      const stat = await fsp.stat(path.join(dir, childRel));
      out.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

// Список папок верхнего уровня внутри dir с числом файлов и суммарным размером.
// Возвращает [{ name, fileCount, size }].
async function listTopFolders(dir) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const folders = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    const files = await scanFiles(path.join(dir, dirent.name));
    const size = files.reduce((sum, f) => sum + f.size, 0);
    folders.push({ name: dirent.name, fileCount: files.length, size });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return folders;
}

// Быстрый список имён папок верхнего уровня — только readdir, без рекурсии.
// Используется для мгновенного показа списка; детали (размер/счёт) грузятся отдельно.
async function listTopFolderNames(dir) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return dirents
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

// Прямые дети папки: и подпапки, и файлы (без рекурсии). Быстро — один readdir.
// Возвращает [{ name, isDir }].
async function listChildren(dir) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) out.push({ name: d.name, isDir: true });
    else if (d.isFile()) out.push({ name: d.name, isDir: false });
  }
  return out;
}

// Полный рекурсивный обход дерева для подсчёта размеров.
// Для каждого узла вызывает onEntry(relPath, isDir, size, fileCount).
// Для файла size — размер файла, fileCount = 1. Для папки — агрегаты по вложенному.
// Возвращает агрегат { size, count } для переданного rel.
async function crawlTree(root, rel, onEntry) {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { size: 0, count: 0 };
    throw err;
  }

  let size = 0;
  let count = 0;
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      const sub = await crawlTree(root, childRel, onEntry);
      await onEntry(childRel, true, sub.size, sub.count);
      size += sub.size;
      count += sub.count;
    } else if (d.isFile()) {
      const st = await fsp.stat(path.join(root, childRel));
      await onEntry(childRel, false, st.size, 1);
      size += st.size;
      count += 1;
    }
  }
  return { size, count };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function copyFile(srcRoot, dstRoot, relPath) {
  const src = path.join(srcRoot, relPath);
  const dst = path.join(dstRoot, relPath);
  await ensureDir(path.dirname(dst));
  await fsp.copyFile(src, dst);
  // Переносим mtime, чтобы последующие сравнения считали файлы одинаковыми.
  const stat = await fsp.stat(src);
  await fsp.utimes(dst, stat.atime, stat.mtime);
}

// Выполняет план синхронизации из src.js.
// trashFn(absPath) — функция удаления в Корзину (в Electron это shell.trashItem).
// onProgress({ done, total, action, path }) — колбэк прогресса (необязателен).
async function applyPlan(srcRoot, dstRoot, plan, trashFn, onProgress = () => {}) {
  const total = plan.copy.length + plan.overwrite.length + plan.trash.length;
  let done = 0;
  const report = (action, relPath) => {
    done += 1;
    onProgress({ done, total, action, path: relPath });
  };

  for (const entry of plan.copy) {
    await copyFile(srcRoot, dstRoot, entry.path);
    report('copy', entry.path);
  }
  for (const entry of plan.overwrite) {
    await copyFile(srcRoot, dstRoot, entry.path);
    report('overwrite', entry.path);
  }
  for (const entry of plan.trash) {
    await trashFn(path.join(dstRoot, entry.path));
    report('trash', entry.path);
  }

  return { done, total };
}

module.exports = {
  scanFiles,
  listTopFolders,
  listTopFolderNames,
  listChildren,
  crawlTree,
  applyPlan,
  copyFile,
  ensureDir,
};
