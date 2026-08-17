'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const crypto = require('crypto');
const { summarize } = require('./src/sync');
const { scanFiles, listChildren, crawlTree, applyPlan, restoreStage } = require('./src/fsops');
const { buildRunPlan, countByFolder, scanFromIndex } = require('./src/plan');
const { rootsOverlap, ciKey } = require('./src/paths');

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

// Выбрасывает записи, которым по возрасту всё равно уже нельзя верить.
// Просроченную запись перезаписывает только повторный запрос ровно того же
// ключа, а ключ — это путь ветки плюс исключения: за долгую сессию их набирается
// сколько угодно разных, и ни одна не освобождалась. Скан большой ветки держит
// запись на каждый файл, так что копилось это гигабайтами.
function pruneScanCache(now) {
  for (const [key, scan] of scanCache) {
    if (now - scan.at >= SCAN_TTL_MS) scanCache.delete(key);
  }
}

// Возвращает { files, dirs, skipped } — все списки относительно absFolderPath.
// skipped — папки, закрытые правами: заглянуть внутрь не дали. Планировщик
// обходит их стороной на обеих сторонах сразу.
async function getScan(absFolderPath, excludes = null, onFile = null) {
  const key = cacheKey(absFolderPath, excludes);
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit;
  const dirs = [];
  const skipped = [];
  const files = await scanFiles(absFolderPath, '', [], excludes, onFile, null, dirs, skipped);
  const now = Date.now();
  pruneScanCache(now);
  scanCache.set(key, { files, dirs, skipped, at: now });
  return scanCache.get(key);
}

// Из общего списка исключений берёт те, что лежат внутри ветки folder,
// и делает их относительными к folder (как ждёт scanFiles).
// Регистр не сверяем по той же причине, что и везде: имя ветки могло прийти
// с той стороны, которая пишет его иначе.
function branchExcludes(excludes, folder) {
  const prefix = folder + '/';
  const set = new Set();
  for (const ex of excludes) {
    if (ex.length > prefix.length && ciKey(ex.slice(0, prefix.length)) === ciKey(prefix)) {
      set.add(ex.slice(prefix.length));
    }
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
  if (root && root === crawlData.localPath) {
    return { files: crawlData.local, dirs: crawlData.localDirs, skipped: crawlData.localSkipped };
  }
  if (root && root === crawlData.networkPath) {
    return { files: crawlData.network, dirs: crawlData.networkDirs, skipped: crawlData.networkSkipped };
  }
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

// Счётчик для имён временных файлов атомарной записи: настройки, кеш размеров
// и история пишутся во временный файл и переименовываются поверх. Осиротевшие
// .tmp разбирает cleanupTempFiles на старте.
let saveSeq = 0;

async function loadSettings() {
  try {
    return JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

// Атомарно, как история и кеш размеров. Обычный writeFile сначала обрезает файл:
// вылет или обрыв питания между обрезанием и записью оставлял на диске пустой
// settings.json, и следующий запуск молча забывал обе выбранные папки — а это
// единственное, что пользователь настраивает руками.
async function saveSettings(settings) {
  try {
    const tmp = `${settingsPath}.${++saveSeq}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(settings, null, 2));
    await fsp.rename(tmp, settingsPath);
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

// Достоверность проверяем здесь же, у самого чтения, — как это делает загрузка
// истории, и по той же причине: иначе каждый следующий читатель начинает с нуля
// и кто-нибудь обязательно забудет. Кеш переживает и смену версии, и обрыв
// питания, а уезжает он прямо в интерфейс как готовые размеры: строка вместо
// массива разбиралась там посимвольно и роняла весь приём обхода.
async function loadSizeCache(localPath, networkPath) {
  try {
    const data = JSON.parse(await fsp.readFile(sizeCacheFile(localPath, networkPath), 'utf8'));
    if (data.localPath !== localPath || data.networkPath !== networkPath) return null;
    if (!Array.isArray(data.entries)) return null;
    return data.entries.filter((e) => e && typeof e.relPath === 'string');
  } catch {
    // нет кеша — не страшно
  }
  return null;
}

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
// У скольких последних запусков храним поимённый список файлов. Остальные
// остаются в истории строкой с итогами, но без перечня.
//
// Пределы перемножались: 200 запусков по 5000 файлов — это 87 МБ в history.json
// и миллион строк в окне истории. Файл целиком перечитывался и переписывался
// после каждой синхронизации, целиком уезжал в renderer и целиком превращался
// в разметку — окно истории вставало намертво, а каждый запуск платил за это
// сотней мегабайт записи. Свежие запуски и есть те, в которые заглядывают;
// у давних важен сам факт и счётчики.
const HISTORY_DETAIL_RUNS = 20;

// Срезает поимённые списки у старых записей. Считаем прямо на чтении и на записи:
// на диске от прежних версий лежит история, выросшая без этого предела, и первым
// же обращением она приходит в норму.
function trimHistoryDetails(list) {
  return list.map((run, i) => {
    if (i < HISTORY_DETAIL_RUNS || !run || !run.files) return run;
    const { files, ...rest } = run;
    return { ...rest, detailsDropped: true, fileCount: files.length };
  });
}

// Битые записи отсеиваем здесь, у самого чтения, а не потом у каждого читателя.
// trimHistoryDetails мусор уже сторожила, а окно истории — нет: одна запись null
// в файле, и разметка обрывалась на полуслове, оставляя «Загрузка…» навсегда.
// Проверять достоверность данных надо там же, где их берут, — иначе каждый
// следующий читатель начинает с нуля и кто-нибудь обязательно забудет.
async function loadHistory() {
  try {
    const list = JSON.parse(await fsp.readFile(historyPath, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((run) => run && typeof run === 'object' && !Array.isArray(run));
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
    await fsp.writeFile(tmp, JSON.stringify(trimHistoryDetails(list)));
    await fsp.rename(tmp, historyPath);
  } catch {
    // история не критична
  }
}

ipcMain.handle('get-history', async () => trimHistoryDetails(await loadHistory()));
ipcMain.handle('clear-history', async () => {
  try {
    await fsp.rm(historyPath, { force: true });
  } catch {
    // ignore
  }
});

// Сколько кешей размеров держим. Кеш заводится на каждую пару путей и живёт
// вечно: перебрал пользователь десяток папок — десяток файлов и остался, а на
// дереве в 300 тысяч узлов каждый весит десятки мегабайт. Никто их не удалял,
// и место утекало молча. Держим только последние по времени записи.
const SIZE_CACHE_KEEP = 6;

// Удаляет осиротевшие временные файлы (.tmp) от прерванных атомарных записей
// и лишние кеши размеров. На старте активных записей ещё нет, поэтому любой
// .tmp — мусор, а любой кеш можно трогать без оглядки на текущую работу.
async function cleanupTempFiles() {
  try {
    const dir = app.getPath('userData');
    const files = await fsp.readdir(dir);
    await Promise.all(
      files
        .filter((f) => f.endsWith('.tmp'))
        .map((f) => fsp.rm(path.join(dir, f), { force: true }).catch(() => {}))
    );

    const caches = files.filter((f) => f.startsWith('sizecache-') && f.endsWith('.json'));
    if (caches.length <= SIZE_CACHE_KEEP) return;
    const dated = await Promise.all(
      caches.map(async (f) => {
        const at = await fsp.stat(path.join(dir, f)).then((s) => s.mtimeMs, () => 0);
        return { f, at };
      })
    );
    dated.sort((a, b) => b.at - a.at);
    await Promise.all(
      dated.slice(SIZE_CACHE_KEEP).map((e) => fsp.rm(path.join(dir, e.f), { force: true }).catch(() => {}))
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

  // Без этого ссылка переживает само окно, и обработчик второго экземпляра
  // дёргает уничтоженный объект — Электрон отвечает на это исключением.
  mainWindow.on('closed', () => {
    mainWindow = null;
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
    if (!mainWindow || mainWindow.isDestroyed()) return;
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

  // Достоверность списка берём у самой listChildren: она отвечает ok=false, если
  // прочитать папку не удалось. Раньше это выяснялось отдельным stat — а stat
  // по закрытой правами папке проходит, тогда как readdir нет, и нечитаемая
  // сторона выдавалась за доступную и опустевшую. Renderer по такому ответу
  // считал список достоверным и стирал отметки выбранных папок; список
  // обновляется каждые 6 секунд, так что одна осечка чтения уносила весь выбор.
  const [local, network] = await Promise.all([
    localDir ? listChildren(localDir, needMtime) : { items: [], ok: false },
    networkDir ? listChildren(networkDir, needMtime) : { items: [], ok: false },
  ]);
  const localOk = local.ok;
  const networkOk = network.ok;

  // Объединяем детей с обеих сторон по имени, помечая присутствие, тип и дату.
  // Ключ — имя без учёта регистра: файловая система не различает 'Docs' и 'docs',
  // а точное сравнение выдавало одну папку за две, каждую с пометкой «нет на другой
  // стороне». Показываем то написание, что пришло первым.
  const map = new Map(); // ciKey(name) -> { name, isDir, hasLocal, hasNetwork, mtimeMs }
  const merge = (entries, sideKey) => {
    for (const e of entries) {
      const key = ciKey(e.name);
      const m =
        map.get(key) ||
        { name: e.name, isDir: false, hasLocal: false, hasNetwork: false, mtimeMs: 0 };
      m.isDir = m.isDir || e.isDir;
      m[sideKey] = true;
      if (e.mtimeMs > m.mtimeMs) m.mtimeMs = e.mtimeMs; // берём более свежую сторону
      map.set(key, m);
    }
  };
  merge(local.items, 'hasLocal');
  merge(network.items, 'hasNetwork');

  // Сортировка: сначала папки, потом файлы; внутри — по имени.
  const merged = [...map.values()].sort((A, B) => {
    if (A.isDir !== B.isDir) return A.isDir ? -1 : 1;
    return A.name.localeCompare(B.name);
  });

  const items = merged.map((m) => ({
    name: m.name,
    relPath: relPath ? `${relPath}/${m.name}` : m.name,
    isDir: m.isDir,
    hasLocal: m.hasLocal,
    hasNetwork: m.hasNetwork,
    mtimeMs: m.mtimeMs,
  }));

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
async function crawlSide(root, onEntry, skippedOut) {
  if (!(await isDir(root))) return false;
  await crawlTree(root, '', onEntry, null, skippedOut);
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
  // Папки, закрытые правами. Держим их рядом с индексом: план обязан обойти
  // их так же, как это делает живой скан, иначе включённый подсчёт размеров
  // менял бы результат синхронизации.
  const skipLocal = [];
  const skipNetwork = [];
  crawlData = {
    localPath,
    networkPath,
    local: fileLocal,
    network: fileNetwork,
    localDirs: dirLocal,
    networkDirs: dirNetwork,
    localSkipped: skipLocal,
    networkSkipped: skipNetwork,
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
  // Сохраняет кеш, только если этот обход всё ещё текущий. Погашенный обход
  // дописывал свой черновик уже после того, как пришедший ему на смену успевал
  // сохранить полный: на диске оставалась половина дерева, и следующий запуск
  // показывал её как готовые размеры.
  const saveIfCurrent = () => {
    if (token !== crawlToken) return Promise.resolve();
    return saveSizeCache(localPath, networkPath, [...index.values()]);
  };

  const maybeSave = () => {
    const interval = Math.min(40000, Math.max(5000, index.size / 8));
    if (saving || Date.now() - lastSave < interval) return;
    saving = true;
    lastSave = Date.now();
    saveIfCurrent().finally(() => {
      saving = false;
    });
  };

  // Ключ — путь без учёта регистра. Стороны могут писать одну и ту же папку
  // по-разному ('Док' против 'док'), а строка в дереве одна: при точном ключе
  // размеры расходились по двум записям, и та, чьё написание в дерево не попало,
  // не показывалась вовсе — рядом с именем висела пустота вместо размера.
  // Первое написание сохраняем: по нему renderer и находит строку.
  const put = (rel, sideKey, cntKey, size, cnt) => {
    if (token !== crawlToken) throw new Error('aborted');
    if (!noLimit && scanned >= MAX_CRAWL) throw new Error('toobig');
    const key = ciKey(rel);
    let e = index.get(key);
    if (!e) {
      e = { relPath: rel, sizeLocal: null, cntLocal: null, sizeNetwork: null, cntNetwork: null };
      index.set(key, e);
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
      }, skipLocal);
      if (!ok) trusted = false;
    }
    if (networkPath) {
      const ok = await crawlSide(networkPath, (rel, isFolder, size, cnt, mtimeMs) => {
        put(rel, 'sizeNetwork', 'cntNetwork', size, cnt);
        if (isFolder) dirNetwork.add(rel);
        else fileNetwork.set(rel, { size, mtimeMs });
      }, skipNetwork);
      if (!ok) trusted = false;
    }
    flush();
    if (token !== crawlToken) return { ok: false, aborted: true };
    await saveIfCurrent();
    const noAccess = skipLocal.length + skipNetwork.length;
    // Синхронизация, прошедшая за время обхода, обнуляет crawlData: приёмник
    // изменился, и собранный индекс описывает уже не то дерево. Тогда отмечать
    // нечего — план пересканирует стороны заново.
    if (crawlData && crawlData.local === fileLocal) {
      crawlData.complete = trusted; // только полный обход годится вместо скана
      crawlData.at = Date.now();
    }
    // noAccess — не обрыв связи, а закрытые правами папки: размеры без них
    // неполны, но это не повод звать чинить сеть. Сообщения об этом разные.
    post('crawl-done', { scanned, ok: true, partial: !trusted, noAccess });
    return { ok: true, scanned, partial: !trusted, noAccess };
  } catch (err) {
    // Сохраняем частичный прогресс даже при обрыве обхода — но только если
    // обход всё ещё наш: погашенному тут писать уже нечего, его место занял новый.
    await saveIfCurrent();
    if (err.message === 'aborted') return { ok: false, aborted: true };
    if (err.message === 'toobig') {
      post('crawl-done', { scanned, ok: false, toobig: true });
      return { ok: false, toobig: true };
    }
    post('crawl-done', { scanned, ok: false, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    // Ссылку на индекс снимаем всегда. Раньше её сбрасывал только удачный исход,
    // и после обрыва она держала оборванный черновик: закрытие окна сохраняло
    // на диск его, затирая полный кеш от следующего, уже удавшегося обхода.
    if (activeCrawl && activeCrawl.index === index) activeCrawl = null;
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

// Прошлый запуск мог оборваться на полпути (вылет, обрыв сети). Тогда в служебной
// папке лежат оригиналы — возвращаем их, прежде чем считать план.
// Разбираем обе стороны, а не только приёмник: оборвавшийся запуск мог идти
// в другую сторону, и тогда оригиналы лежат в том корне, который сейчас источник.
// Не разобрать их — значит принять их за пропавшие и стереть на второй стороне.
//
// Зовут это и запуск, и предпросмотр, и именно в таком порядке: пока разбор делал
// один запуск, предпросмотр видел на месте отложенного файла дыру и обещал
// скопировать его заново. Человек соглашался на одну работу, а получал другую —
// обещанное «скопировать 1» оборачивалось «0/0 Готово».
async function restoreBothStages(srcRoot, dstRoot) {
  const counts = await Promise.all(
    [srcRoot, dstRoot].map((root) => restoreStage(root).catch(() => 0))
  );
  const restored = counts[0] + counts[1];
  if (restored > 0) {
    scanCache.clear();
    crawlData = null; // дерево изменилось — прежний индекс уже неверен
  }
  return restored;
}

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
    await restoreBothStages(srcRoot, dstRoot);
    const plan = await buildRunPlan(srcRoot, dstRoot, folders, excludes, makeScanner(onFile));
    return {
      perFolder: countByFolder(plan, folders),
      totals: summarize(plan),
      destTrashable: supportsTrash(dstRoot),
      // Закрытые правами папки: работой они не станут, но и промолчать о них
      // нельзя — иначе ветка не синхронизируется, а отчёт объявляет «Готово».
      skipped: (plan.skipped || []).slice(0, 20),
      skippedTotal: (plan.skipped || []).length,
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
// Замок на время работы. Два запуска разом делят служебную папку на приёмнике
// так же, как две копии приложения: restoreStage второго на старте возвращает
// «брошенные» оригиналы прямо из-под первого, который в этот момент ими и занят.
// От второго процесса защищает одиночный экземпляр, а от второго вызова — этот
// флаг. Интерфейс на время работы блокирует кнопку, но полагаться на интерфейс
// нельзя: последствия доходят до файлов.
let syncRunning = false;
ipcMain.handle('sync', async (event, args) => {
  if (syncRunning) return { error: 'синхронизация уже идёт' };
  syncRunning = true;
  try {
    return await performSync(event, args);
  } finally {
    syncRunning = false;
  }
});

async function performSync(event, { localPath, networkPath, folders, excludes = [], direction }) {
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
  // Считаем именно файлы, ушедшие мимо Корзины, а не «был ли такой случай».
  // Раньше здесь стоял флаг, и один-единственный файл, который не приняла
  // Корзина, окрашивал весь запуск: отчёт объявлял безвозвратно удалённым
  // всё, что вообще было удалено.
  let permanentDeletes = 0;
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
  // weight — сколько файлов покрывает вызов: служебная папка уезжает одним
  // действием на всё содержимое сразу.
  const trashFn = async (absPath, weight = 1) => {
    if (dstTrashable) {
      try {
        await shell.trashItem(absPath);
        return;
      } catch {
        // не удалось в Корзину — удаляем безвозвратно ниже
      }
    }
    await rmForce(absPath);
    permanentDeletes += weight;
  };

  await restoreBothStages(srcRoot, dstRoot);

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
      permanentDeletes,
      failures: res.failures.length,
      files,
      filesTruncated: allEntries.length - files.length,
    });
  }

  return {
    done: res.done,
    total: res.total,
    permanentDeletes,
    unrecoverable: res.unrecoverable,
    failures: res.failures.length,
    failuresSample: res.failures.slice(0, 5).map((f) => `${f.path} (${f.code})`),
    skippedTotal: (plan.skipped || []).length,
  };
}
