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

// Коды, которыми файловая система отвечает «эту папку тебе смотреть нельзя».
// Отличать их от прочих ошибок обязательно: закрытую папку мы обходим стороной,
// а вот сбой чтения (нет памяти, кончились дескрипторы, оборвалась сеть) обязан
// прервать обход с ошибкой. Молча принять такой сбой за закрытую папку значило бы
// строить план по неполным данным.
const DENIED_CODES = new Set(['EPERM', 'EACCES']);

// Что делать, если stat по файлу не удался. readdir только что показал этот файл,
// но живая папка меняется под руками: временные файлы, кеш браузера, сборка.
// Раньше любая осечка stat обрывала весь скан — предпросмотр отвечал «не удалось
// прочитать папки» из-за одного исчезнувшего файла, а синхронизация не начиналась.
//   'gone'  — файла действительно нет, отсутствие в списке и есть правда;
//   'blind' — есть, но размера не знаем: молча выбросить нельзя, пустое место
//             на источнике означает «на приёмнике лишнее», и копия уехала бы
//             в Корзину. Отдаём наверх тем же списком, что и закрытые папки;
//   иначе   — сбой чтения (нет дескрипторов, оборвалась сеть) обязан прервать
//             обход: строить план по неполным данным опаснее, чем не строить.
function fileStatVerdict(err, skippedOut) {
  if (err.code === 'ENOENT') return 'gone';
  if (DENIED_CODES.has(err.code) && skippedOut) return 'blind';
  return 'fatal';
}

// Рекурсивно собирает список файлов внутри dir.
// Возвращает массив записей { path, size, mtimeMs }, path — относительный,
// с разделителем '/'. Символические ссылки пропускаются (не ходим по ним).
// excludes — Set путей папок (относительно dir), которые нужно пропустить целиком.
// onFile() — необязательный колбэк на каждый найденный файл (прогресс/отмена).
// dirsOut — необязательный массив, куда складываются относительные пути папок.
// skippedOut — необязательный массив, куда складывается то, что закрыто правами:
//   папки, внутрь которых заглянуть не дали, и отдельные файлы, у которых
//   не читается даже размер. Раньше такая папка обрывала весь обход:
//   одна закрытая ветка (System Volume Information в корне диска, папка с чужими
//   правами на шаре) — и предпросмотр целиком отвечал EPERM, а синхронизация
//   не начиналась вовсе. Пустым списком её содержимое подменить нельзя: пустой
//   источник означает «на приёмнике всё лишнее», и одна ошибка прав обернулась бы
//   удалением живой ветки. Поэтому папку возвращаем наверх, и планировщик
//   выбрасывает её содержимое из рассмотрения на обеих сторонах разом.
// Файлы читаются параллельно с ограничением SCAN_CONCURRENCY.
// Исключения приводим к нижнему регистру один раз, на входе: путь ветки мог
// прийти с той стороны, которая пишет имя иначе, а файловая система разницы
// не видит. Дальше рекурсия работает уже с готовым набором.
async function scanFiles(dir, rel = '', out = [], excludes = null, onFile = null, run = null, dirsOut = null, skippedOut = null) {
  const skip = excludes && !run ? new Set([...excludes].map((e) => e.toLowerCase())) : excludes;
  return scanInto(dir, rel, out, skip, onFile, run, dirsOut, skippedOut);
}

async function scanInto(dir, rel, out, excludes, onFile, run, dirsOut, skippedOut) {
  const limit = run || createLimiter(SCAN_CONCURRENCY);
  let dirents;
  try {
    dirents = await limit(() => fsp.readdir(path.join(dir, rel), { withFileTypes: true }));
  } catch (err) {
    if (err.code === 'ENOENT') return out; // папки нет — пустой список
    if (DENIED_CODES.has(err.code) && skippedOut) {
      skippedOut.push(rel);
      return out;
    }
    throw err;
  }

  const tasks = [];
  for (const dirent of dirents) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (excludes && excludes.has(childRel.toLowerCase())) continue; // исключённая ветка
    if (dirent.isSymbolicLink()) continue;
    if (dirent.name === STAGE_DIR) continue;
    if (dirent.isDirectory()) {
      if (dirsOut) dirsOut.push(childRel);
      tasks.push(scanInto(dir, childRel, out, excludes, onFile, limit, dirsOut, skippedOut));
    } else if (dirent.isFile()) {
      tasks.push(
        limit(() => fsp.stat(path.join(dir, childRel))).then(
          (stat) => {
            out.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
            if (onFile) onFile();
          },
          // Обработчик именно вторым аргументом then, а не отдельным catch: catch
          // поймал бы и 'aborted', который бросает onFile при отмене предпросмотра,
          // и отмена утонула бы вместе с ошибками файлов.
          (err) => {
            const verdict = fileStatVerdict(err, skippedOut);
            if (verdict === 'blind') skippedOut.push(childRel);
            else if (verdict === 'fatal') throw err;
          }
        )
      );
    }
  }
  await Promise.all(tasks);
  return out;
}

// Прямые дети папки: и подпапки, и файлы (без рекурсии).
// Возвращает { items: [{ name, isDir, mtimeMs }], ok }.
// ok=false — прочитать папку не удалось (нет её, нет прав, оборвалась сеть).
// Без этого флага пустой список означал сразу две разные вещи: «папка пуста»
// и «прочитать не вышло». Вызывающий разбирал их отдельным stat, но stat —
// другой системный вызов: по закрытой правами папке он проходит, а readdir нет,
// и нечитаемая сторона выдавалась за доступную и опустевшую. Интерфейс по такому
// ответу стирал отметки выбранных папок, а держал их там пользователь.
// withMtime=false — только readdir (быстро, без stat по каждому; дата = 0).
// withMtime=true — дополнительно stat по каждому ребёнку (для сортировки по дате),
// параллельно. Нужно только когда выбрана сортировка по дате.
async function listChildren(dir, withMtime = false) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // Ошибку не бросаем: отвалившаяся сторона не должна рушить весь листинг,
    // а вторая сторона по-прежнему годится к показу.
    return { items: [], ok: false };
  }

  const kids = dirents.filter(
    (d) => !d.isSymbolicLink() && d.name !== STAGE_DIR && (d.isDirectory() || d.isFile())
  );

  if (!withMtime) {
    // Быстрый путь: одна readdir, без обращений к каждому файлу.
    return { items: kids.map((d) => ({ name: d.name, isDir: d.isDirectory(), mtimeMs: 0 })), ok: true };
  }

  const limit = createLimiter(SCAN_CONCURRENCY);
  const items = [];
  const tasks = kids.map((d) => {
    const isDir = d.isDirectory();
    return limit(() => fsp.stat(path.join(dir, d.name))).then(
      (st) => items.push({ name: d.name, isDir, mtimeMs: st.mtimeMs }),
      () => items.push({ name: d.name, isDir, mtimeMs: 0 }) // stat не удался — всё равно показываем
    );
  });
  await Promise.all(tasks);
  return { items, ok: true };
}

// Полный рекурсивный обход дерева для подсчёта размеров.
// Для каждого узла вызывает onEntry(relPath, isDir, size, fileCount).
// Для файла size — размер файла, fileCount = 1. Для папки — агрегаты по вложенному.
// skippedOut — куда складывать папки, закрытые правами: обход их не роняет,
// но и содержимого их не знает, а по такому индексу план строить нельзя.
// Возвращает агрегат { size, count } для переданного rel.
async function crawlTree(root, rel, onEntry, run = null, skippedOut = null) {
  const limit = run || createLimiter(SCAN_CONCURRENCY);
  let dirents;
  try {
    dirents = await limit(() => fsp.readdir(path.join(root, rel), { withFileTypes: true }));
  } catch (err) {
    if (err.code === 'ENOENT') return { size: 0, count: 0 };
    if (DENIED_CODES.has(err.code) && skippedOut) {
      skippedOut.push(rel);
      return { size: 0, count: 0 };
    }
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
        crawlTree(root, childRel, onEntry, limit, skippedOut).then(async (sub) => {
          await onEntry(childRel, true, sub.size, sub.count, null);
          size += sub.size;
          count += sub.count;
        })
      );
    } else if (d.isFile()) {
      tasks.push(
        limit(() => fsp.stat(path.join(root, childRel))).then(
          async (st) => {
            await onEntry(childRel, false, st.size, 1, st.mtimeMs);
            size += st.size;
            count += 1;
          },
          // Вторым аргументом, а не catch: onEntry бросает 'aborted' и 'toobig',
          // и погасить обход эти броски обязаны по-прежнему.
          (err) => {
            const verdict = fileStatVerdict(err, skippedOut);
            if (verdict === 'blind') skippedOut.push(childRel);
            else if (verdict === 'fatal') throw err;
          }
        )
      );
    }
  }
  await Promise.all(tasks);
  return { size, count };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Сколько файлов лежит в узле. Файл — это один; папка — сумма по содержимому.
// Прочитать не вышло — считаем за один: занизить отчёт о безвозвратном удалении
// хуже, чем завысить, а разбираться в причине здесь уже не с чем.
async function countFiles(abs) {
  let dirents;
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return 1;
  }
  let n = 0;
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    n += d.isDirectory() ? await countFiles(path.join(abs, d.name)) : 1;
  }
  return n;
}

// Сколько байт сверяем с каждого конца, когда файл крупный. Мелкий читается
// целиком: именно мелкие файлы (config.json, __init__.py, метки) чаще всего
// и совпадают по имени с размером, будучи совершенно разными.
const SAMPLE_BYTES = 65536;

async function readAt(fh, size, pos) {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const { bytesRead } = await fh.read(buf, got, size - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === size ? buf : buf.subarray(0, got);
}

async function edges(file, size) {
  const fh = await fsp.open(file, 'r');
  try {
    if (size <= SAMPLE_BYTES * 2) return readAt(fh, size, 0);
    return Buffer.concat([
      await readAt(fh, SAMPLE_BYTES, 0),
      await readAt(fh, SAMPLE_BYTES, size - SAMPLE_BYTES),
    ]);
  } finally {
    await fh.close();
  }
}

// Один ли это файл на двух сторонах. Читаем края, а не весь файл: переименование
// дерева на сотню гигабайт иначе стоило бы столько же, сколько копирование,
// а ради этого перемещения и распознаются.
async function sameContent(a, b) {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  if (sa.size === 0) return true;
  const [ea, eb] = await Promise.all([edges(a, sa.size), edges(b, sb.size)]);
  return ea.equals(eb);
}

// Возвращает true если скопировал, false если источник исчез (устаревшие данные).
// ensure — чем создавать папку назначения. По умолчанию обычный mkdir, но
// синхронизация передаёт сюда свой кеш: без него каждый файл тянул за собой
// отдельный рекурсивный mkdir, и на ветке в сотню тысяч файлов это была сотня
// тысяч лишних обращений к сети — при том, что папка почти всегда одна и та же.
async function copyFile(srcRoot, dstRoot, relPath, ensure = ensureDir) {
  const src = path.join(srcRoot, relPath);
  const dst = path.join(dstRoot, relPath);

  await ensure(path.dirname(dst));
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

// Сносит пустые папки снизу вверх. Возвращает true, если dir остался пуст.
// Пустой каркас внутри служебной папки — наших рук дело: его создавали мы сами,
// раскладывая оригиналы по вложенным путям, и после возврата содержимого он
// ничего не значит. Всё остальное — файл, ссылка, непустая ветка — значит, что
// узел вернуть не удалось.
async function pruneEmptyDirs(dir) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return true; // папки нет — считаем пустой
    return false; // заглянуть не вышло — тем более не трогаем
  }
  let empty = true;
  for (const d of dirents) {
    const sub = path.join(dir, d.name);
    if (d.isDirectory() && !d.isSymbolicLink() && (await pruneEmptyDirs(sub))) {
      try {
        await fsp.rmdir(sub);
        continue;
      } catch {
        // убрать не вышло — папка остаётся, и вместе с ней вся ветка
      }
    }
    empty = false;
  }
  return empty;
}

// Убирает служебную папку, но только если внутри ничего не осталось.
// Если что-то осталось (оригинал, который не удалось ни заменить, ни вернуть),
// папка уцелеет: содержимое разберёт restoreStage на следующем запуске.
// Стереть её вслепую значило бы уничтожить единственную копию файла молча.
//
// Содержимое считаем обходом каталогов, а не scanFiles: тот собирает только
// файлы и намеренно не видит ни пустых папок, ни ссылок, ни узлов с именем
// служебной папки. Служебная папка, внутри которой лежала отложенная пустая
// ветка, проходила по такому счёту как пустая — и уезжала в rm вместе с ней.
async function removeStageIfEmpty(stageRoot) {
  if (!(await pruneEmptyDirs(stageRoot))) return false;
  await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  return true;
}

// Возвращает узлы служебной папки на свои места: сверху вниз и целиком.
// Если на месте узла ничего нет, один rename возвращает всё поддерево разом —
// это и быстрее (по сети одна операция вместо тысячи), и сохраняет пустые папки,
// которых поштучный обход по файлам попросту не видел.
// Место занято папкой — разбираем её содержимое по одному, вглубь.
async function restoreTree(stageDir, dstDir, stats) {
  let dirents;
  try {
    dirents = await fsp.readdir(stageDir, { withFileTypes: true });
  } catch {
    return; // заглянуть не вышло — оставляем как есть до следующего запуска
  }
  try {
    await ensureDir(dstDir);
  } catch {
    return; // некуда возвращать (путь занят файлом) — пусть ждёт
  }

  await runPool(dirents, APPLY_CONCURRENCY, async (d) => {
    const from = path.join(stageDir, d.name);
    const to = path.join(dstDir, d.name);
    try {
      await fsp.rename(from, to);
      stats.restored += 1;
      return;
    } catch {
      // место занято или узел держат открытым
    }
    if (!d.isDirectory() || d.isSymbolicLink()) return;
    // На месте уже стоит папка: сливаем содержимое, а опустевший каркас убираем.
    await restoreTree(from, to, stats);
    await fsp.rmdir(from).catch(() => {});
  });
}

// Возвращает содержимое служебной папки приёмника обратно на свои места.
// Нужна на старте синхронизации: если прошлый запуск оборвался (вылет, отключение
// питания), в папке лежат оригиналы, которые он не успел ни вернуть, ни выбросить.
// Прерванный запуск считаем несостоявшимся, поэтому откатываем его целиком.
async function restoreStage(dstRoot) {
  const stageRoot = path.join(dstRoot, STAGE_DIR);
  const stats = { restored: 0 };
  await restoreTree(stageRoot, dstRoot, stats);
  await removeStageIfEmpty(stageRoot);
  return stats.restored;
}

// Выполняет план синхронизации из src/sync.js.
//
// Каждое действие пишется в журнал, поэтому остановку можно откатить. Оригиналы
// (перезаписываемые и удаляемые файлы) не уничтожаются сразу, а переименовываются
// в служебную папку внутри приёмника: переименование мгновенно даже по сети,
// а откат сводится к обратному переименованию. Мусор выбрасывается одним
// действием в самом конце, когда стало ясно, что запуск дошёл до конца.
//
// trashFn(absPath, weight) — удаление (в Электроне через Корзину, на сети —
//   напрямую). weight — сколько файлов покрывает вызов: служебная папка уезжает
//   одним действием на всё содержимое, и вызывающему нужно знать его вес, чтобы
//   верно посчитать, сколько ушло мимо Корзины.
// onProgress({ done, total, action, path }) — колбэк прогресса.
// opts.shouldStop() — если вернёт true, работа прекращается и всё откатывается.
//
// Ошибка отдельного файла не обрывает синхронизацию: копится в failures.
async function applyPlan(srcRoot, dstRoot, plan, trashFn, onProgress = () => {}, opts = {}) {
  const shouldStop = opts.shouldStop || (() => false);
  const moves = plan.moves || [];
  const dirsCreate = (plan.dirs && plan.dirs.create) || [];
  const dirsRemove = (plan.dirs && plan.dirs.remove) || [];
  const conflicts = plan.conflicts || [];
  const stageRoot = path.join(dstRoot, STAGE_DIR);

  const total =
    conflicts.length +
    dirsCreate.length +
    moves.length +
    plan.copy.length +
    plan.overwrite.length +
    plan.trash.length +
    dirsRemove.length;

  let done = 0;
  let stopped = false;
  const failures = [];
  // conflict живёт отдельно от stage, хотя убирает файлы тем же способом:
  // откат разворачивает журнал ровно в обратном порядке фаз, а конфликты идут
  // самой первой фазой — значит возвращать их надо самыми последними, уже после
  // того, как исчезнут папки, созданные на их месте.
  const journal = { conflict: [], mkdir: [], move: [], copy: [], overwrite: [], stage: [], rmdir: [] };

  const report = (action, relPath) => {
    done += 1;
    onProgress({ done, total, action, path: relPath });
  };
  const fail = (action, relPath, err) => {
    failures.push({ action, path: relPath, code: err.code || String(err.message) });
  };

  // mkdir по каждому файлу заметно тормозит на сети, поэтому помним созданное.
  // Помним именно обещание, а не отметку о готовности: отметка ставилась после
  // await, а файлы идут пачкой по APPLY_CONCURRENCY штук — все шестнадцать
  // успевали проскочить проверку до того, как первый допишет ответ, и mkdir
  // всё равно улетал на каждый файл. Кеш не срабатывал ни разу.
  // Неудачу не запоминаем: следующий вызов должен попробовать заново.
  const madeDirs = new Map();
  const ensureOnce = (dir) => {
    let pending = madeDirs.get(dir);
    if (!pending) {
      pending = fsp.mkdir(dir, { recursive: true });
      madeDirs.set(dir, pending);
      pending.catch(() => madeDirs.delete(dir));
    }
    return pending;
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
        if (await copyFile(srcRoot, dstRoot, mv.to, ensureOnce)) {
          journal.copy.push(mv.to);
          await stash(mv.from);
          journal.stage.push(mv.from);
        } else {
          // Источник исчез после сканирования. Оригинал не трогаем: убери мы его,
          // файл пропал бы с обеих сторон, а копировать уже нечего.
          fail('move', mv.to, { code: 'ENOENT' });
        }
      } catch (err) {
        fail('move', mv.to, err);
      }
    }
    report('move', mv.to);
  };

  const doCopy = async (entry) => {
    try {
      // false — источник исчез после сканирования. Копировать нечего, и записывать
      // в журнал тоже нечего: иначе история отчиталась бы о несуществующей копии.
      if (await copyFile(srcRoot, dstRoot, entry.path, ensureOnce)) journal.copy.push(entry.path);
      else fail('copy', entry.path, { code: 'ENOENT' });
    } catch (err) {
      fail('copy', entry.path, err);
    }
    report('copy', entry.path);
  };

  // Сколько файлов обработано в обход журнала (слишком длинный путь и т.п.).
  // Их откат не вернёт, поэтому число видно снаружи.
  let unrecoverable = 0;

  // Сколько файлов покрывает один отложенный узел. Обычно ровно один, и только
  // конфликт типа уезжает целой веткой — см. doConflict.
  const parkedWeight = new Map();
  const weightOf = (rel) => (parkedWeight.has(rel) ? parkedWeight.get(rel) : 1);

  // Оригиналы, застрявшие в служебной папке: отложены, заменить не вышло, вернуть
  // на место — тоже (путь занят, файл держат открытым). В журнал они не попадают,
  // а в конце работы служебная папка уезжает в Корзину целиком — вместе с ними,
  // хотя другой копии у этих файлов нет. Помним их, чтобы выбросить только своё.
  const orphans = [];
  const putBack = async (relPath) => {
    try {
      await unstash(relPath);
    } catch {
      orphans.push(relPath);
    }
  };

  const doOverwrite = async (entry) => {
    let parked = true;
    try {
      await stash(entry.path);
    } catch {
      // Не удалось отложить оригинал — пишем поверх, как делалось раньше.
      // Откатить такой файл будет нечем, зато синхронизация не встанет.
      parked = false;
    }
    try {
      if (await copyFile(srcRoot, dstRoot, entry.path, ensureOnce)) {
        if (parked) journal.overwrite.push(entry.path);
        // Оригинал затёрт копией, а откат разворачивает только то, что лежит
        // в служебной папке. Считаем потерю здесь, а не сразу после неудачного
        // stash: если копия следом не легла, оригинал цел и терять нечего.
        else unrecoverable += 1;
      } else {
        // Источник исчез после сканирования. Заменять нечем, поэтому возвращаем
        // отложенный оригинал: без этого он уехал бы в Корзину вместе с мусором,
        // а на его месте не оказалось бы ничего.
        if (parked) await putBack(entry.path);
        fail('overwrite', entry.path, { code: 'ENOENT' });
      }
    } catch (err) {
      // Оригинал уже убран, а новый не лёг — возвращаем старый, чтобы файл не пропал.
      if (parked) await putBack(entry.path);
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

  // Узел, у которого на сторонах разный тип: на источнике папка, а на приёмнике
  // файл с тем же именем (или наоборот). Убираем его первым делом — иначе mkdir
  // упрётся в файл, а копирование файла ляжет поверх папки и упадёт. Уезжает он
  // тем же путём, что и остальные оригиналы: в служебную папку, поэтому остановка
  // возвращает его на место, а Корзину он увидит только в самом конце.
  const doConflict = async (rel) => {
    // Считаем содержимое до того, как узел тронут. Конфликт — единственное место,
    // где в служебную папку уезжает не файл, а целая ветка: всё остальное в plan
    // приходит из скана по файлам и весит ровно единицу. Без этого счёта папка
    // на пять файлов отчитывалась как один безвозвратно удалённый, а на сетевом
    // приёмнике, где Корзины нет, это единственная цифра о потере.
    const вес = await countFiles(path.join(dstRoot, rel));
    parkedWeight.set(rel, вес);
    try {
      await stash(rel);
      journal.conflict.push(rel);
    } catch {
      // Отложить не вышло — убираем сразу, вернуть будет нечем.
      try {
        await trashFn(path.join(dstRoot, rel), вес);
        unrecoverable += 1;
      } catch (err) {
        fail('trash', rel, err);
      }
    }
    report('trash', rel);
  };

  // Последовательный вариант phase: для папок порядок важен, пул тут не годится.
  const steps = async (items, worker) => {
    if (stopped) return;
    for (const item of items) {
      if (shouldStop()) {
        stopped = true;
        return;
      }
      await worker(item);
    }
  };

  await steps(conflicts, doConflict);

  // Папки создаём от мелких к глубоким, поэтому по порядку и без пула.
  await steps(dirsCreate, async (rel) => {
    try {
      await fsp.mkdir(path.join(dstRoot, rel), { recursive: true });
      journal.mkdir.push(rel);
    } catch (err) {
      fail('mkdir', rel, err);
    }
    report('mkdir', rel);
  });

  await phase(moves, doMove);
  await phase(plan.copy, doCopy);
  await phase(plan.overwrite, doOverwrite);
  await phase(plan.trash, doStage);

  // Лишние папки убираем от глубоких к мелким. Именно rmdir, а не rm -r:
  // он падает на непустой папке, и это защита — если внутри осталось что-то
  // исключённое из синхронизации, папка уцелеет.
  await steps(dirsRemove, async (rel) => {
    try {
      await fsp.rmdir(path.join(dstRoot, rel));
      journal.rmdir.push(rel);
    } catch {
      // не пустая или уже нет — так и задумано
    }
    report('rmdir', rel);
  });

  if (stopped) {
    await rollback(dstRoot, stageRoot, journal);
    return { done, total, failures, cancelled: true, unrecoverable };
  }

  // Дошли до конца — только теперь оригиналы отправляются в Корзину.
  // Одним действием на всю папку: это на порядок быстрее, чем по файлу,
  // и в Корзине запуск лежит одной восстановимой пачкой.
  let trashed = 0;
  const parked = [...journal.stage, ...journal.overwrite, ...journal.conflict];
  const parkedCount = parked.length;
  // Узлов и файлов тут разное число: узел, снятый конфликтом типа, — это папка.
  // Решение «есть ли что выбрасывать» принимаем по узлам, а вес обещаем по файлам.
  const parkedFiles = parked.reduce((n, rel) => n + weightOf(rel), 0);
  if (parkedCount > 0) {
    if (orphans.length === 0) {
      try {
        // Вес вызова передаём явно: одним действием уезжает всё содержимое
        // папки, и без него один безвозвратно удалённый файл в отчёте выглядел
        // бы так же, как весь запуск мимо Корзины.
        await trashFn(stageRoot, parkedFiles);
        trashed = parkedCount;
      } catch (err) {
        // Выбросить не удалось — служебную папку оставляем как есть.
        // Стереть её здесь значило бы уничтожить оригиналы молча.
        fail('trash', STAGE_DIR, err);
      }
    } else {
      // Внутри застрял чужой оригинал: его не удалось ни заменить, ни вернуть,
      // и другой копии у него нет. Папку целиком тут выбрасывать нельзя —
      // убираем поимённо только то, что записано в журнале, а застрявшее
      // остаётся дожидаться restoreStage на следующем запуске.
      // Осечка на одном оригинале не отменяет уборку остальных: раньше цикл
      // обрывался на первом же, и уже заменённые файлы возвращались на приёмник
      // со следующим запуском — как будто их и не удаляли.
      await runPool(parked, APPLY_CONCURRENCY, async (rel) => {
        try {
          await trashFn(path.join(stageRoot, rel), weightOf(rel));
          trashed += 1;
        } catch (err) {
          fail('trash', rel, err);
        }
      });
    }
    // Убираем каркас папок, если trashFn забрал только содержимое.
    await removeStageIfEmpty(stageRoot);
  } else {
    // Выбрасывать нечего, но внутри мог остаться отложенный оригинал, который
    // не удалось ни заменить, ни вернуть. Такую папку не трогаем.
    await removeStageIfEmpty(stageRoot);
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

  // Конфликтные узлы — последними: на их месте стояла папка (или файл) из фаз
  // выше, и вернуть оригинал можно только теперь, когда место освободилось.
  await runPool(journal.conflict, APPLY_CONCURRENCY, async (rel) => {
    await ensureDir(path.dirname(abs(rel))).catch(() => {});
    try {
      await fsp.rename(path.join(stageRoot, rel), abs(rel));
    } catch {
      // Место всё ещё занято тем, что успел создать этот же запуск (папка, из
      // которой не убрался неудавшийся файл). Убираем помеху и пробуем ещё раз.
      // Сносим только после неудачной попытки: вслепую тут ничего не удаляем.
      await fsp.rm(abs(rel), { recursive: true, force: true }).catch(() => {});
      await fsp.rename(path.join(stageRoot, rel), abs(rel)).catch(() => {});
    }
  });

  // Всё, что удалось вернуть, уже на местах. Если внутри что-то осталось,
  // папку не трогаем — разберём на следующем запуске.
  await removeStageIfEmpty(stageRoot);
}

module.exports = {
  scanFiles,
  listChildren,
  crawlTree,
  applyPlan,
  restoreStage,
  copyFile,
  ensureDir,
  sameContent,
  runPool,
  APPLY_CONCURRENCY,
  STAGE_DIR,
};
