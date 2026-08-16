'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const crypto = require('crypto');
const { summarize } = require('./src/sync');
const { scanFiles, listChildren, crawlTree, applyPlan, restoreStage } = require('./src/fsops');
const { buildRunPlan, countByFolder, scanFromIndex } = require('./src/plan');
const { rootsOverlap } = require('./src/paths');

let mainWindow;

// Кеш сканов: ключ (путь + исключения) → массив записей файлов.
// Один скан на ветку переиспользуется предпросмотром и синхронизацией,
// чтобы не гонять по сети одни и те же stat-запросы повторно.
const scanCache = new Map();

// Скан живёт ограниченное время. Связка «предпросмотр → выполнить» укладывается
// в минуты, а вот окно, открытое с утра, к вечеру описывает диск, которого уже нет:
// по такому скану план получится из устаревших данных, и разница между сторонами
// будет посчитана неверно.
const SCAN_TTL_MS = 15 * 60 * 1000;

function cacheKey(absFolderPath, excludes) {
  if (!excludes || excludes.size === 0) return absFolderPath;
  return absFolderPath + '\0' + [...excludes].sort().join('\0');
}

// Возвращает { files, dirs } — оба списка относительно absFolderPath.
async function getScan(absFolderPath, excludes = null, onFile = null) {
  const key = cacheKey(absFolderPath, excludes);
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit;
  const dirs = [];
  const files = await scanFiles(absFolderPath, '', [], excludes, onFile, null, dirs);
  const scan = { files, dirs, at: Date.now() };
  scanCache.set(key, scan);
  return scan;
}

// Из общего списка исключений берёт те, что лежат внутри ветки folder,
// и делает их относительными к folder (как ждёт scanFiles).
function branchExcludes(excludes, folder) {
  const set = new Set();
  for (const ex of excludes) {
    if (ex.startsWith(folder + '/')) set.add(ex.slice(folder.length + 1));
  }
  return set;
}

// Корзина недоступна на сетевых (UNC) путях вида \\Комп\Папка.
function supportsTrash(root) {
  return !!root && !root.startsWith('\\\\');
}

// Есть ли папка прямо сейчас. Отсутствующую папку сканеры отдают пустым списком,
// поэтому недоступную сторону невозможно отличить от пустой — а разница между
// ними это разница между «нечего делать» и «удалить с приёмника всё».
async function isDir(p) {
  if (!p) return false;
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Обе стороны должны быть на месте прежде, чем строить план. Оборванная сеть
// даёт пустой источник, а пустой источник означает «всё на приёмнике лишнее».
async function assertRootsReachable(srcRoot, dstRoot) {
  const [srcOk, dstOk] = await Promise.all([isDir(srcRoot), isDir(dstRoot)]);
  if (!srcOk) throw new Error(`папка-источник недоступна (${srcRoot || 'не выбрана'})`);
  if (!dstOk) throw new Error(`папка-приёмник недоступна (${dstRoot || 'не выбрана'})`);
  if (rootsOverlap(srcRoot, dstRoot)) {
    throw new Error('папки вложены друг в друга — выберите непересекающиеся');
  }
}


// Возвращает индексы стороны root из завершённого обхода, или null.
// Срок жизни у индекса тот же, что у сканов, и по той же причине: он подменяет
// собой живой скан, а значит к вечеру описывает диск, которого уже нет. Разница
// лишь в том, что обход переживает и «Обновить», и выключение подсчёта размеров,
// поэтому без срока он оставался бы единственным непроверяемым источником данных.
function crawlSideFor(root) {
  if (!crawlData || !crawlData.complete) return null;
  if (Date.now() - crawlData.at > SCAN_TTL_MS) return null;
  if (root && root === crawlData.localPath) return { files: crawlData.local, dirs: crawlData.localDirs };
  if (root && root === crawlData.networkPath) return { files: crawlData.network, dirs: crawlData.networkDirs };
  return null;
}

// Файлы и папки ветки branch (пути относительно branch): из обхода, иначе живой скан.
// onFile нужен предпросмотру для прогресса и отмены, поэтому сканер собирается
// на каждый запуск отдельно.
function makeScanner(onFile = null) {
  return (root, branch, excludes) => branchScan(root, branch, excludes, onFile);
}

async function branchScan(root, branch, excludes, onFile) {
  const idx = crawlSideFor(root);
  if (idx) return scanFromIndex(idx, branch, excludes);
  return getScan(path.join(root, branch), branchExcludes(excludes, branch), onFile);
}

// ---- Настройки (запоминание путей между запусками) ----
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try {
    return JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveSettings(settings) {
  try {
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    // настройки не критичны — молча игнорируем сбой записи
  }
}

// ---- Кеш размеров на диске (мгновенный показ при следующем открытии) ----
function sizeCacheFile(localPath, networkPath) {
  const hash = crypto
    .createHash('md5')
    .update(`${localPath || ''}\0${networkPath || ''}`)
    .digest('hex');
  return path.join(app.getPath('userData'), `sizecache-${hash}.json`);
}

async function loadSizeCache(localPath, networkPath) {
  try {
    const data = JSON.parse(await fsp.readFile(sizeCacheFile(localPath, networkPath), 'utf8'));
    if (data.localPath === localPath && data.networkPath === networkPath) return data.entries;
  } catch {
    // нет кеша — не страшно
  }
  return null;
}

let saveSeq = 0;
// Атомарная запись: сначала во временный файл, затем переименование —
// частичный/оборванный кеш не повредит уже сохранённый.
async function saveSizeCache(localPath, networkPath, entries) {
  try {
    const file = sizeCacheFile(localPath, networkPath);
    const tmp = `${file}.${++saveSeq}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ localPath, networkPath, entries }));
    await fsp.rename(tmp, file);
  } catch {
    // кеш не критичен
  }
}

function saveSizeCacheSync(localPath, networkPath, entries) {
  try {
    fs.writeFileSync(
      sizeCacheFile(localPath, networkPath),
      JSON.stringify({ localPath, networkPath, entries })
    );
  } catch {
    // кеш не критичен
  }
}

// ---- История синхронизаций ----
const historyPath = path.join(app.getPath('userData'), 'history.json');
const HISTORY_MAX_RUNS = 200; // сколько запусков храним
const HISTORY_FILE_CAP = 5000; // максимум файлов в одной записи (удаления в приоритете)

async function loadHistory() {
  try {
    const list = JSON.parse(await fsp.readFile(historyPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function appendHistory(record) {
  try {
    const list = await loadHistory();
    list.unshift(record); // новые сверху
    if (list.length > HISTORY_MAX_RUNS) list.length = HISTORY_MAX_RUNS;
    const tmp = `${historyPath}.${++saveSeq}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list));
    await fsp.rename(tmp, historyPath);
  } catch {
    // история не критична
  }
}

ipcMain.handle('get-history', () => loadHistory());
ipcMain.handle('clear-history', async () => {
  try {
    await fsp.rm(historyPath, { force: true });
  } catch {
    // ignore
  }
});

// Удаляет осиротевшие временные файлы (.tmp) от прерванных атомарных записей.
// На старте активных записей ещё нет, поэтому любой .tmp — мусор.
async function cleanupTempFiles() {
  try {
    const dir = app.getPath('userData');
    const files = await fsp.readdir(dir);
    await Promise.all(
      files
        .filter((f) => f.endsWith('.tmp'))
        .map((f) => fsp.rm(path.join(dir, f), { force: true }).catch(() => {}))
    );
  } catch {
    // не критично
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1c2128',
    title: 'SyncGlass',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Второй экземпляр не запускаем. Две копии делят и служебную папку на приёмнике,
// и кеши в userData: restoreStage второго запуска на старте вернёт «брошенные»
// оригиналы прямо из-под первого, который в этот момент ими и занят. Вместо
// нового окна поднимаем уже открытое.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    cleanupTempFiles();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_event, settings) => saveSettings(settings));

// Выбор папки через системный диалог.
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Ленивый листинг прямых подпапок на уровне relPath (по умолчанию — корень).
// Возвращает объединение папок с обеих сторон, без рекурсии — быстро даже по сети.
// force=true сбрасывает кеш сканов (кнопка «Обновить»).
ipcMain.handle('list-folders', async (_event, { localPath, networkPath, relPath = '', force, needMtime = false }) => {
  if (force) {
    scanCache.clear();
    // «Обновить» жмут именно потому, что данные под руками устарели. Индекс
    // обхода — такие же данные: не сбросить его значило бы читать заново только
    // список папок, а план по-прежнему строить по старому снимку.
    crawlData = null;
  }

  const localDir = localPath ? path.join(localPath, relPath) : null;
  const networkDir = networkPath ? path.join(networkPath, relPath) : null;

  // Пустой список от listChildren означает и «папка пуста», и «прочитать не вышло»:
  // ошибку она глушит намеренно, чтобы отвалившаяся сеть не рушила весь листинг.
  // Отличить одно от другого обязан вызывающий, иначе renderer примет моргнувшую
  // сторону за опустевшую и сотрёт отметки выбранных папок — а их там держит
  // пользователь, и восстановить их некому.
  const [local, network, localOk, networkOk] = await Promise.all([
    localDir ? listChildren(localDir, needMtime) : [],
    networkDir ? listChildren(networkDir, needMtime) : [],
    isDir(localDir),
    isDir(networkDir),
  ]);

  // Объединяем детей с обеих сторон по имени, помечая присутствие, тип и дату.
  const map = new Map(); // name -> { isDir, hasLocal, hasNetwork, mtimeMs }
  const merge = (entries, sideKey) => {
    for (const e of entries) {
      const m = map.get(e.name) || { isDir: false, hasLocal: false, hasNetwork: false, mtimeMs: 0 };
      m.isDir = m.isDir || e.isDir;
      m[sideKey] = true;
      if (e.mtimeMs > m.mtimeMs) m.mtimeMs = e.mtimeMs; // берём более свежую сторону
      map.set(e.name, m);
    }
  };
  merge(local, 'hasLocal');
  merge(network, 'hasNetwork');

  // Сортировка: сначала папки, потом файлы; внутри — по имени.
  const names = [...map.keys()].sort((a, b) => {
    const A = map.get(a);
    const B = map.get(b);
    if (A.isDir !== B.isDir) return A.isDir ? -1 : 1;
    return a.localeCompare(b);
  });

  const items = names.map((name) => {
    const m = map.get(name);
    return {
      name,
      relPath: relPath ? `${relPath}/${name}` : name,
      isDir: m.isDir,
      hasLocal: m.hasLocal,
      hasNetwork: m.hasNetwork,
      mtimeMs: m.mtimeMs,
    };
  });

  return { items, localOk, networkOk };
});

// Проверка доступности папок (лёгкая — один stat на сторону).
ipcMain.handle('probe', async (_event, { localPath, networkPath }) => {
  const [localOk, networkOk] = await Promise.all([isDir(localPath), isDir(networkPath)]);
  return { localOk, networkOk };
});

// ---- Фоновый обход дерева: размеры и количество файлов ----
// Токен гасит предыдущий обход, если начался новый (смена путей / «Обновить» / стоп).
let crawlToken = 0;
// Предохранитель: на очень больших деревьях подсчёт размеров останавливается,
// чтобы не съесть память и не блокировать интерфейс. Синхронизация не страдает —
// она сканирует только выбранные ветки.
const MAX_CRAWL = 300000;

ipcMain.handle('stop-crawl', () => {
  crawlToken += 1;
  // Обход остановлен — обновлять индекс больше нечему, а несвежий он опаснее
  // отсутствующего: план по нему выглядит достоверным. Пусть план сканирует сам.
  crawlData = null;
});
// Текущий обход — чтобы сохранить прогресс при закрытии окна.
let activeCrawl = null; // { index, localPath, networkPath }
// Данные завершённого обхода по каждому файлу — переиспользуются предпросмотром
// и синхронизацией, чтобы не читать сеть повторно.
// { localPath, networkPath, local: Map(rel->{size,mtimeMs}), network: Map, complete }
let crawlData = null;

// Обходит одну сторону и говорит, можно ли доверять собранному индексу.
// Папку проверяем до и после: пропавшая посреди обхода сеть отдаёт ENOENT,
// crawlTree принимает это за пустую ветку, и получается частичный индекс —
// а он опаснее отсутствия индекса, потому что по нему приёмник выглядит лишним.
async function crawlSide(root, onEntry) {
  if (!(await isDir(root))) return false;
  await crawlTree(root, '', onEntry);
  return isDir(root);
}

ipcMain.handle('start-crawl', async (event, { localPath, networkPath, noLimit = false }) => {
  const token = ++crawlToken;

  // Окно могли закрыть посреди обхода — тогда отправка бросает, и без обёртки
  // исключение улетело бы в обработчик ошибок самого обхода.
  const post = (channel, payload) => {
    try {
      event.sender.send(channel, payload);
    } catch {
      // получателя больше нет — работу это не отменяет
    }
  };

  // Сразу отдаём кешированные размеры с прошлого раза — мгновенный показ.
  // Шлём кусками, чтобы renderer не завис на одном огромном сообщении (сотни тысяч).
  const cached = await loadSizeCache(localPath, networkPath);
  if (cached && token === crawlToken) {
    for (let i = 0; i < cached.length; i += 5000) {
      if (token !== crawlToken) break;
      post('crawl-cached', { entries: cached.slice(i, i + 5000) });
    }
  }

  const index = new Map(); // relPath -> { sizeLocal, cntLocal, sizeNetwork, cntNetwork }
  activeCrawl = { index, localPath, networkPath };
  // Индекс по каждому файлу и папке для переиспользования в плане синхронизации.
  const fileLocal = new Map();
  const fileNetwork = new Map();
  const dirLocal = new Set();
  const dirNetwork = new Set();
  crawlData = {
    localPath,
    networkPath,
    local: fileLocal,
    network: fileNetwork,
    localDirs: dirLocal,
    networkDirs: dirNetwork,
    complete: false,
    at: 0,
  };
  let scanned = 0;
  let batch = [];
  let lastSave = Date.now();
  let saving = false;

  const flush = () => {
    if (batch.length === 0) return;
    post('crawl-progress', { scanned, entries: batch });
    batch = [];
  };

  // Периодически сбрасываем накопленное на диск, чтобы прогресс не терялся.
  // Сериализация всего индекса блокирует поток, поэтому чем больше индекс —
  // тем реже сохраняем (5 c для мелких деревьев … до 40 c для сотен тысяч).
  const maybeSave = () => {
    const interval = Math.min(40000, Math.max(5000, index.size / 8));
    if (saving || Date.now() - lastSave < interval) return;
    saving = true;
    lastSave = Date.now();
    saveSizeCache(localPath, networkPath, [...index.values()]).finally(() => {
      saving = false;
    });
  };

  const put = (rel, sideKey, cntKey, size, cnt) => {
    if (token !== crawlToken) throw new Error('aborted');
    if (!noLimit && scanned >= MAX_CRAWL) throw new Error('toobig');
    let e = index.get(rel);
    if (!e) {
      e = { relPath: rel, sizeLocal: null, cntLocal: null, sizeNetwork: null, cntNetwork: null };
      index.set(rel, e);
    }
    e[sideKey] = size;
    e[cntKey] = cnt;
    scanned += 1;
    batch.push(e);
    if (batch.length >= 300) flush();
    maybeSave();
  };

  // Индексу можно доверять, только если каждая заданная сторона была на месте
  // и до, и после обхода. Иначе он останется черновиком для показа размеров,
  // а план синхронизации пересканирует всё заново.
  let trusted = true;

  try {
    if (localPath) {
      const ok = await crawlSide(localPath, (rel, isFolder, size, cnt, mtimeMs) => {
        put(rel, 'sizeLocal', 'cntLocal', size, cnt);
        if (isFolder) dirLocal.add(rel);
        else fileLocal.set(rel, { size, mtimeMs });
      });
      if (!ok) trusted = false;
    }
    if (networkPath) {
      const ok = await crawlSide(networkPath, (rel, isFolder, size, cnt, mtimeMs) => {
        put(rel, 'sizeNetwork', 'cntNetwork', size, cnt);
        if (isFolder) dirNetwork.add(rel);
        else fileNetwork.set(rel, { size, mtimeMs });
      });
      if (!ok) trusted = false;
    }
    flush();
    if (token !== crawlToken) return { ok: false, aborted: true };
    await saveSizeCache(localPath, networkPath, [...index.values()]);
    if (activeCrawl && activeCrawl.index === index) activeCrawl = null;
    // Синхронизация, прошедшая за время обхода, обнуляет crawlData: приёмник
    // изменился, и собранный индекс описывает уже не то дерево. Тогда отмечать
    // нечего — план пересканирует стороны заново.
    if (crawlData && crawlData.local === fileLocal) {
      crawlData.complete = trusted; // только полный обход годится вместо скана
      crawlData.at = Date.now();
    }
    post('crawl-done', { scanned, ok: true, partial: !trusted });
    return { ok: true, scanned, partial: !trusted };
  } catch (err) {
    // Сохраняем частичный прогресс даже при обрыве обхода.
    await saveSizeCache(localPath, networkPath, [...index.values()]);
    if (err.message === 'aborted') return { ok: false, aborted: true };
    if (err.message === 'toobig') {
      if (activeCrawl && activeCrawl.index === index) activeCrawl = null;
      post('crawl-done', { scanned, ok: false, toobig: true });
      return { ok: false, toobig: true };
    }
    post('crawl-done', { scanned, ok: false, error: err.message });
    return { ok: false, error: err.message };
  }
});

// Сохраняем прогресс обхода при закрытии (синхронно). Для очень больших деревьев
// пропускаем — синхронная сериализация надолго заблокировала бы выход; периодическое
// сохранение по ходу уже сохранило почти весь прогресс.
app.on('before-quit', () => {
  if (activeCrawl && activeCrawl.index.size > 0 && activeCrawl.index.size <= 150000) {
    saveSizeCacheSync(activeCrawl.localPath, activeCrawl.networkPath, [
      ...activeCrawl.index.values(),
    ]);
  }
});

// Предпросмотр: строит план для выбранных веток и возвращает сводку + детали.
// folders — относительные пути папок (могут быть вложенными).
// direction: 'toNetwork' (локально→сеть) или 'toLocal' (сеть→локально).
// Никогда не отклоняется: при обрыве/отмене возвращает { aborted } или { error }.
let previewToken = 0;
ipcMain.handle('cancel-preview', () => {
  previewToken += 1;
});

ipcMain.handle('preview', async (event, { localPath, networkPath, folders, excludes = [], direction }) => {
  const srcRoot = direction === 'toNetwork' ? localPath : networkPath;
  const dstRoot = direction === 'toNetwork' ? networkPath : localPath;
  const token = ++previewToken;

  let scanned = 0;
  let lastSent = 0;
  const onFile = () => {
    if (token !== previewToken) throw new Error('aborted');
    scanned += 1;
    const now = Date.now();
    if (now - lastSent > 150) {
      lastSent = now;
      try {
        event.sender.send('preview-progress', { scanned });
      } catch {
        // окно закрыли — счётчик показывать некому
      }
    }
  };

  try {
    await assertRootsReachable(srcRoot, dstRoot);
    const plan = await buildRunPlan(srcRoot, dstRoot, folders, excludes, makeScanner(onFile));
    return {
      perFolder: countByFolder(plan, folders),
      totals: summarize(plan),
      destTrashable: supportsTrash(dstRoot),
    };
  } catch (err) {
    if (err.message === 'aborted') return { aborted: true };
    return { error: err.message };
  }
});

// Остановка идущей синхронизации. Флаг проверяется между файлами; всё уже
// сделанное откатывается по журналу внутри applyPlan.
let syncStopped = false;
ipcMain.handle('cancel-sync', () => {
  syncStopped = true;
});

// Выполнение синхронизации выбранных веток. Прогресс шлётся в renderer событиями.
ipcMain.handle('sync', async (event, { localPath, networkPath, folders, excludes = [], direction }) => {
  const srcRoot = direction === 'toNetwork' ? localPath : networkPath;
  const dstRoot = direction === 'toNetwork' ? networkPath : localPath;
  syncStopped = false;

  // Первым делом — до restoreStage, которая уже двигает файлы. Недоступная
  // сторона здесь означала бы план «удалить с приёмника всё», поэтому просто
  // не начинаем: пусть пользователь сначала починит связь.
  try {
    await assertRootsReachable(srcRoot, dstRoot);
  } catch (err) {
    return { error: err.message };
  }

  // На сетевых (UNC) путях Корзины нет — там удаляем напрямую.
  // На локальных пытаемся в Корзину, при сбое (папка занята и т.п.) — тоже напрямую.
  const dstTrashable = supportsTrash(dstRoot);
  let permanent = false;
  const rmForce = async (absPath) => {
    try {
      await fsp.rm(absPath, { recursive: true, force: true });
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        await fsp.chmod(absPath, 0o666).catch(() => {});
        await fsp.rm(absPath, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  };
  const trashFn = async (absPath) => {
    if (dstTrashable) {
      try {
        await shell.trashItem(absPath);
        return;
      } catch {
        // не удалось в Корзину — удаляем безвозвратно ниже
      }
    }
    await rmForce(absPath);
    permanent = true;
  };

  // Прошлый запуск мог оборваться на полпути (вылет, обрыв сети). Тогда в служебной
  // папке лежат оригиналы — возвращаем их, прежде чем считать текущий план.
  // Разбираем обе стороны, а не только приёмник: оборвавшийся запуск мог идти
  // в другую сторону, и тогда оригиналы лежат в том корне, который сейчас источник.
  // Не разобрать их — значит принять их за пропавшие и стереть на второй стороне.
  const restoredCounts = await Promise.all(
    [srcRoot, dstRoot].map((root) => restoreStage(root).catch(() => 0))
  );
  const restored = restoredCounts[0] + restoredCounts[1];
  if (restored > 0) {
    scanCache.clear();
    crawlData = null; // приёмник изменился — прежний индекс уже неверен
  }

  // Скан может оборваться на полпути (сеть отвалилась после проверки корней).
  // Тогда план строить не на чем — выходим до того, как хоть что-то тронули.
  let plan;
  try {
    plan = await buildRunPlan(srcRoot, dstRoot, folders, excludes, makeScanner());
  } catch (err) {
    // Сорвался обычно обрыв связи. Что успели прочитать до него — уже под вопросом,
    // поэтому кеши сбрасываем: следующая попытка пойдёт за свежими данными.
    scanCache.clear();
    crawlData = null;
    return { error: `не удалось прочитать папки (${err.message})` };
  }
  const totals = summarize(plan);

  // Прогресс шлём не чаще ~10 раз в секунду: при параллельной обработке 500k
  // файлов иначе улетело бы полмиллиона IPC-сообщений и завалило renderer.
  // Счётчики по действиям считаем точно и передаём снимком (throttle не теряет счёт).
  const doneBy = { move: 0, copy: 0, overwrite: 0, trash: 0 };
  let lastSent = 0;

  // Окно могли закрыть посреди работы. Тогда отправка события бросает, и без
  // этой обёртки исключение прервало бы саму синхронизацию на полуслове.
  const notify = (payload) => {
    try {
      event.sender.send('sync-progress', payload);
    } catch {
      // получателя больше нет — работу это не отменяет
    }
  };

  // Дальше уже идут записи на приёмник. Сорваться applyPlan может только на чём-то
  // непредвиденном (ошибки по отдельным файлам она копит сама), но если это случилось,
  // отвечать надо всё равно: без ответа окно так и висит на «Начинаю…».
  let res;
  try {
    res = await applyPlan(
      srcRoot,
      dstRoot,
      plan,
      trashFn,
      ({ done, total, action, path: relPath }) => {
        if (doneBy[action] !== undefined) doneBy[action] += 1;
        const now = Date.now();
        if (now - lastSent >= 100 || done === total) {
          lastSent = now;
          notify({ done, total, action, path: relPath, by: { ...doneBy } });
        }
      },
      { shouldStop: () => syncStopped }
    );
  } catch (err) {
    scanCache.clear();
    crawlData = null;
    return { error: err.message, started: true };
  }

  // Приёмник изменился — кеши устарели, сбрасываем перед следующим обновлением.
  scanCache.clear();
  crawlData = null;

  if (res.cancelled) {
    notify({ done: res.done, total: res.total, action: 'rollback', path: '', by: { ...doneBy } });
    return {
      cancelled: true,
      done: res.done,
      total: res.total,
      failures: res.failures.length,
      unrecoverable: res.unrecoverable,
    };
  }

  // ---- Запись в историю ----
  if (totals.total > 0) {
    // failures помечены путём, по которому шла операция: у перемещения это mv.to.
    const failSet = new Set(res.failures.map((f) => `${f.action} ${f.path}`));
    const collect = (action, list, label = (e) => e.path) =>
      list
        .filter((e) => !failSet.has(`${action} ${e.path}`))
        .map((e) => ({ action, path: label(e) }));

    // Конфликты типа тоже убирают узел с приёмника — в истории им место рядом
    // с остальными удалениями, иначе итог обещает больше, чем перечисляет.
    const conflictEntries = (plan.conflicts || []).map((rel) => ({ path: rel }));

    const allEntries = [
      ...collect('trash', conflictEntries),
      ...collect('trash', plan.trash),
      ...collect('move', plan.moves, (m) => `${m.from} → ${m.to}`),
      ...collect('overwrite', plan.overwrite),
      ...collect('copy', plan.copy),
    ];
    const files = allEntries.slice(0, HISTORY_FILE_CAP);

    await appendHistory({
      time: new Date().toISOString(),
      direction,
      localPath,
      networkPath,
      totals: {
        move: totals.move,
        copy: totals.copy,
        overwrite: totals.overwrite,
        trash: totals.trash,
        dirs: totals.dirs,
      },
      permanentDeletes: permanent ? res.trashed : 0,
      failures: res.failures.length,
      files,
      filesTruncated: allEntries.length - files.length,
    });
  }

  return {
    done: res.done,
    total: res.total,
    permanentDeletes: permanent ? res.trashed : 0,
    unrecoverable: res.unrecoverable,
    failures: res.failures.length,
    failuresSample: res.failures.slice(0, 5).map((f) => `${f.path} (${f.code})`),
  };
});
