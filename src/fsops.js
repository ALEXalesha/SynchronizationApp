'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Число одновременных файловых запросов. По сети (SMB) чтение упирается в задержку
// каждого запроса, поэтому пачка параллельных stat ускоряет обход в разы.
const SCAN_CONCURRENCY = 32;

// Служебная папка внутри приёмника. Туда на время синхронизации уезжают оригиналы
// удаляемых и перезаписываемых файлов, чтобы остановку можно было откатить.
// Ни один обход её не видит, иначе она попала бы в план как «лишние файлы».
// Имя короткое намеренно: путь внутри неё длиннее исходного, а Windows упирается
// в 260 символов. Чем короче префикс, тем реже срабатывает запасной путь.
const STAGE_DIR = '.sgundo';

// Ограничитель параллельности: не больше max одновременных операций.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active += 1;
      fn().then(resolve, reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

// Рекурсивно собирает список файлов внутри dir.
// Возвращает массив записей { path, size, mtimeMs }, path — относительный,
// с разделителем '/'. Символические ссылки пропускаются (не ходим по ним).
// excludes — Set путей папок (относительно dir), которые нужно пропустить целиком.
// onFile() — необязательный колбэк на каждый найденный файл (прогресс/отмена).
// dirsOut — необязательный массив, куда складываются относительные пути папок.
// Файлы читаются параллельно с ограничением SCAN_CONCURRENCY.
async function scanFiles(dir, rel = '', out = [], excludes = null, onFile = null, run = null, dirsOut = null) {
  const limit = run || createLimiter(SCAN_CONCURRENCY);
  let dirents;
  try {
    dirents = await limit(() => fsp.readdir(path.join(dir, rel), { withFileTypes: true }));
  } catch (err) {
    if (err.code === 'ENOENT') return out; // папки нет — пустой список
    throw err;
  }

  const tasks = [];
  for (const dirent of dirents) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (excludes && excludes.has(childRel)) continue; // исключённая ветка
    if (dirent.isSymbolicLink()) continue;
    if (dirent.name === STAGE_DIR) continue;
    if (dirent.isDirectory()) {
      if (dirsOut) dirsOut.push(childRel);
      tasks.push(scanFiles(dir, childRel, out, excludes, onFile, limit, dirsOut));
    } else if (dirent.isFile()) {
      tasks.push(
        limit(() => fsp.stat(path.join(dir, childRel))).then((stat) => {
          out.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
          if (onFile) onFile();
        })
      );
    }
  }
  await Promise.all(tasks);
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
    if (dirent.name === STAGE_DIR) continue;
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
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && d.name !== STAGE_DIR)
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

// Прямые дети папки: и подпапки, и файлы (без рекурсии).
// Возвращает [{ name, isDir, mtimeMs }].
// withMtime=false — только readdir (быстро, без stat по каждому; дата = 0).
// withMtime=true — дополнительно stat по каждому ребёнку (для сортировки по дате),
// параллельно. Нужно только когда выбрана сортировка по дате.
async function listChildren(dir, withMtime = false) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // Папки нет или сторона недоступна (сеть отвалилась) — показываем пусто,
    // а не рушим весь листинг. Доступность отражают индикаторы связи.
    return [];
  }

  const kids = dirents.filter(
    (d) => !d.isSymbolicLink() && d.name !== STAGE_DIR && (d.isDirectory() || d.isFile())
  );

  if (!withMtime) {
    // Быстрый путь: одна readdir, без обращений к каждому файлу.
    return kids.map((d) => ({ name: d.name, isDir: d.isDirectory(), mtimeMs: 0 }));
  }

  const limit = createLimiter(SCAN_CONCURRENCY);
  const out = [];
  const tasks = kids.map((d) => {
    const isDir = d.isDirectory();
    return limit(() => fsp.stat(path.join(dir, d.name))).then(
      (st) => out.push({ name: d.name, isDir, mtimeMs: st.mtimeMs }),
      () => out.push({ name: d.name, isDir, mtimeMs: 0 }) // stat не удался — всё равно показываем
    );
  });
  await Promise.all(tasks);
  return out;
}

// Полный рекурсивный обход дерева для подсчёта размеров.
// Для каждого узла вызывает onEntry(relPath, isDir, size, fileCount).
// Для файла size — размер файла, fileCount = 1. Для папки — агрегаты по вложенному.
// Возвращает агрегат { size, count } для переданного rel.
async function crawlTree(root, rel, onEntry, run = null) {
  const limit = run || createLimiter(SCAN_CONCURRENCY);
  let dirents;
  try {
    dirents = await limit(() => fsp.readdir(path.join(root, rel), { withFileTypes: true }));
  } catch (err) {
    if (err.code === 'ENOENT') return { size: 0, count: 0 };
    throw err;
  }

  let size = 0;
  let count = 0;
  const tasks = [];
  for (const d of dirents) {
    if (d.isSymbolicLink() || d.name === STAGE_DIR) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      tasks.push(
        crawlTree(root, childRel, onEntry, limit).then(async (sub) => {
          await onEntry(childRel, true, sub.size, sub.count, null);
          size += sub.size;
          count += sub.count;
        })
      );
    } else if (d.isFile()) {
      tasks.push(
        limit(() => fsp.stat(path.join(root, childRel))).then(async (st) => {
          await onEntry(childRel, false, st.size, 1, st.mtimeMs);
          size += st.size;
          count += 1;
        })
      );
    }
  }
  await Promise.all(tasks);
  return { size, count };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Возвращает true если скопировал, false если источник исчез (устаревшие данные).
async function copyFile(srcRoot, dstRoot, relPath) {
  const src = path.join(srcRoot, relPath);
  const dst = path.join(dstRoot, relPath);

  await ensureDir(path.dirname(dst));
  try {
    await fsp.copyFile(src, dst);
  } catch (err) {
    if (err.code === 'ENOENT') return false; // источник исчез с момента сканирования
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      // приёмник, вероятно, read-only — снимаем атрибут и пробуем снова
      await fsp.chmod(dst, 0o666).catch(() => {});
      await fsp.copyFile(src, dst);
    } else {
      throw err;
    }
  }

  // Перенос даты не критичен: сетевые шары часто запрещают utimes (EPERM).
  // Если не вышло — просто пропускаем, файл всё равно скопирован.
  try {
    const stat = await fsp.stat(src);
    await fsp.utimes(dst, stat.atime, stat.mtime);
  } catch {
    // дату перенести не удалось — не критично
  }
  return true;
}

// Сколько файлов обрабатываем одновременно при синхронизации.
// По сети это скрывает задержку на каждый файл (копирование/удаление идут пачкой).
const APPLY_CONCURRENCY = 16;

// Пул воркеров: concurrency параллельных обработчиков тянут элементы из items
// по индексу. Не создаёт промис на каждый элемент — важно для сотен тысяч файлов.
async function runPool(items, concurrency, worker) {
  let i = 0;
  const runners = [];
  const n = Math.min(concurrency, items.length);
  for (let c = 0; c < n; c += 1) {
    runners.push(
      (async () => {
        while (i < items.length) {
          const idx = i;
          i += 1;
          await worker(items[idx]);
        }
      })()
    );
  }
  await Promise.all(runners);
}

// Возвращает содержимое служебной папки приёмника обратно на свои места.
// Нужна на старте синхронизации: если прошлый запуск оборвался (вылет, отключение
// питания), в папке лежат оригиналы, которые он не успел ни вернуть, ни выбросить.
// Прерванный запуск считаем несостоявшимся, поэтому откатываем его целиком.
async function restoreStage(dstRoot) {
  const stageRoot = path.join(dstRoot, STAGE_DIR);
  const staged = await scanFiles(stageRoot);
  if (staged.length === 0) {
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    return 0;
  }
  let restored = 0;
  await runPool(staged, APPLY_CONCURRENCY, async (entry) => {
    const back = path.join(dstRoot, entry.path);
    try {
      await ensureDir(path.dirname(back));
      await fsp.rename(path.join(stageRoot, entry.path), back);
      restored += 1;
    } catch {
      // файл занят или уже на месте — оставляем в служебной папке
    }
  });
  await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  return restored;
}

// Выполняет план синхронизации из src/sync.js.
//
// Каждое действие пишется в журнал, поэтому остановку можно откатить. Оригиналы
// (перезаписываемые и удаляемые файлы) не уничтожаются сразу, а переименовываются
// в служебную папку внутри приёмника: переименование мгновенно даже по сети,
// а откат сводится к обратному переименованию. Мусор выбрасывается одним
// действием в самом конце, когда стало ясно, что запуск дошёл до конца.
//
// trashFn(absPath) — удаление (в Электроне через Корзину, на сети — напрямую).
// onProgress({ done, total, action, path }) — колбэк прогресса.
// opts.shouldStop() — если вернёт true, работа прекращается и всё откатывается.
//
// Ошибка отдельного файла не обрывает синхронизацию: копится в failures.
async function applyPlan(srcRoot, dstRoot, plan, trashFn, onProgress = () => {}, opts = {}) {
  const shouldStop = opts.shouldStop || (() => false);
  const moves = plan.moves || [];
  const dirsCreate = (plan.dirs && plan.dirs.create) || [];
  const dirsRemove = (plan.dirs && plan.dirs.remove) || [];
  const stageRoot = path.join(dstRoot, STAGE_DIR);

  const total =
    dirsCreate.length +
    moves.length +
    plan.copy.length +
    plan.overwrite.length +
    plan.trash.length +
    dirsRemove.length;

  let done = 0;
  let stopped = false;
  const failures = [];
  const journal = { mkdir: [], move: [], copy: [], overwrite: [], stage: [], rmdir: [] };

  const report = (action, relPath) => {
    done += 1;
    onProgress({ done, total, action, path: relPath });
  };
  const fail = (action, relPath, err) => {
    failures.push({ action, path: relPath, code: err.code || String(err.message) });
  };

  // mkdir по каждому файлу заметно тормозит на сети, поэтому помним созданное.
  const madeDirs = new Set();
  const ensureOnce = async (dir) => {
    if (madeDirs.has(dir)) return;
    await fsp.mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  };

  const stash = async (relPath) => {
    const parked = path.join(stageRoot, relPath);
    await ensureOnce(path.dirname(parked));
    await fsp.rename(path.join(dstRoot, relPath), parked);
  };

  const unstash = async (relPath) => {
    const back = path.join(dstRoot, relPath);
    await ensureDir(path.dirname(back));
    await fsp.rename(path.join(stageRoot, relPath), back);
  };

  // Обёртка над пулом: как только запрошена остановка, новые элементы не берём.
  const phase = async (items, worker) => {
    if (stopped || items.length === 0) return;
    await runPool(items, APPLY_CONCURRENCY, async (item) => {
      if (stopped) return;
      if (shouldStop()) {
        stopped = true;
        return;
      }
      await worker(item);
    });
  };

  const doMove = async (mv) => {
    const to = path.join(dstRoot, mv.to);
    try {
      await ensureOnce(path.dirname(to));
      await fsp.rename(path.join(dstRoot, mv.from), to);
      journal.move.push(mv);
    } catch {
      // Переименовать не вышло (файл занят, разные тома) — работаем как раньше:
      // копируем по новому пути, оригинал убираем в служебную папку.
      try {
        await copyFile(srcRoot, dstRoot, mv.to);
        journal.copy.push(mv.to);
        await stash(mv.from);
        journal.stage.push(mv.from);
      } catch (err) {
        fail('move', mv.to, err);
      }
    }
    report('move', mv.to);
  };

  const doCopy = async (entry) => {
    try {
      await copyFile(srcRoot, dstRoot, entry.path);
      journal.copy.push(entry.path);
    } catch (err) {
      fail('copy', entry.path, err);
    }
    report('copy', entry.path);
  };

  // Сколько файлов обработано в обход журнала (слишком длинный путь и т.п.).
  // Их откат не вернёт, поэтому число видно снаружи.
  let unrecoverable = 0;

  const doOverwrite = async (entry) => {
    let parked = true;
    try {
      await stash(entry.path);
    } catch {
      // Не удалось отложить оригинал — пишем поверх, как делалось раньше.
      // Откатить такой файл будет нечем, зато синхронизация не встанет.
      parked = false;
      unrecoverable += 1;
    }
    try {
      await copyFile(srcRoot, dstRoot, entry.path);
      if (parked) journal.overwrite.push(entry.path);
    } catch (err) {
      // Оригинал уже убран, а новый не лёг — возвращаем старый, чтобы файл не пропал.
      if (parked) await unstash(entry.path).catch(() => {});
      fail('overwrite', entry.path, err);
    }
    report('overwrite', entry.path);
  };

  const doStage = async (entry) => {
    try {
      await stash(entry.path);
      journal.stage.push(entry.path);
    } catch {
      // Не удалось отложить — удаляем сразу, как делалось раньше.
      try {
        await trashFn(path.join(dstRoot, entry.path));
        unrecoverable += 1;
      } catch (err) {
        fail('trash', entry.path, err);
      }
    }
    report('trash', entry.path);
  };

  // Папки создаём от мелких к глубоким, поэтому по порядку и без пула.
  for (const rel of dirsCreate) {
    if (shouldStop()) {
      stopped = true;
      break;
    }
    try {
      await fsp.mkdir(path.join(dstRoot, rel), { recursive: true });
      journal.mkdir.push(rel);
    } catch (err) {
      fail('mkdir', rel, err);
    }
    report('mkdir', rel);
  }

  await phase(moves, doMove);
  await phase(plan.copy, doCopy);
  await phase(plan.overwrite, doOverwrite);
  await phase(plan.trash, doStage);

  // Лишние папки убираем от глубоких к мелким. Именно rmdir, а не rm -r:
  // он падает на непустой папке, и это защита — если внутри осталось что-то
  // исключённое из синхронизации, папка уцелеет.
  if (!stopped) {
    for (const rel of dirsRemove) {
      if (shouldStop()) {
        stopped = true;
        break;
      }
      try {
        await fsp.rmdir(path.join(dstRoot, rel));
        journal.rmdir.push(rel);
      } catch {
        // не пустая или уже нет — так и задумано
      }
      report('rmdir', rel);
    }
  }

  if (stopped) {
    await rollback(dstRoot, stageRoot, journal);
    return { done, total, failures, cancelled: true, unrecoverable };
  }

  // Дошли до конца — только теперь оригиналы отправляются в Корзину.
  // Одним действием на всю папку: это на порядок быстрее, чем по файлу,
  // и в Корзине запуск лежит одной восстановимой пачкой.
  let trashed = 0;
  if (journal.stage.length + journal.overwrite.length > 0) {
    try {
      await trashFn(stageRoot);
      trashed = journal.stage.length + journal.overwrite.length;
      // Убираем каркас папок, если trashFn забрал только содержимое.
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      // Выбросить не удалось — служебную папку оставляем как есть.
      // Стереть её здесь значило бы уничтожить оригиналы молча.
      fail('trash', STAGE_DIR, err);
    }
  } else {
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }

  return { done, total, failures, cancelled: false, trashed, unrecoverable };
}

// Разворачивает журнал в обратном порядке фаз.
async function rollback(dstRoot, stageRoot, journal) {
  const abs = (rel) => path.join(dstRoot, rel);

  for (const rel of [...journal.rmdir].reverse()) {
    await fsp.mkdir(abs(rel), { recursive: true }).catch(() => {});
  }

  await runPool(journal.stage, APPLY_CONCURRENCY, async (rel) => {
    await ensureDir(path.dirname(abs(rel))).catch(() => {});
    await fsp.rename(path.join(stageRoot, rel), abs(rel)).catch(() => {});
  });

  await runPool(journal.overwrite, APPLY_CONCURRENCY, async (rel) => {
    await fsp.rm(abs(rel), { force: true }).catch(() => {});
    await fsp.rename(path.join(stageRoot, rel), abs(rel)).catch(() => {});
  });

  await runPool(journal.copy, APPLY_CONCURRENCY, async (rel) => {
    await fsp.rm(abs(rel), { force: true }).catch(() => {});
  });

  await runPool(journal.move, APPLY_CONCURRENCY, async (mv) => {
    await ensureDir(path.dirname(abs(mv.from))).catch(() => {});
    await fsp.rename(abs(mv.to), abs(mv.from)).catch(() => {});
  });

  for (const rel of [...journal.mkdir].reverse()) {
    await fsp.rmdir(abs(rel)).catch(() => {});
  }

  await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
}

module.exports = {
  scanFiles,
  listTopFolders,
  listTopFolderNames,
  listChildren,
  crawlTree,
  applyPlan,
  restoreStage,
  copyFile,
  ensureDir,
  STAGE_DIR,
};
