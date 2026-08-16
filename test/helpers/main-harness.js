'use strict';

// Поднимает main.js с подменённым модулем electron и отдаёт наружу
// зарегистрированные IPC-обработчики, чтобы их можно было вызывать напрямую.
// Без этого main.js — самый крупный файл проекта — не покрывался ничем:
// его логика (кеши, токены обхода, история, разбор служебной папки на старте)
// проверялась только запуском приложения вручную.

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;

const APP_ROOT = path.join(__dirname, '..', '..');

function electronStub(userDataDir, handlers, trashed) {
  return {
    app: {
      getPath: () => userDataDir,
      requestSingleInstanceLock: () => true,
      on: () => {},
      whenReady: () => Promise.resolve(),
      quit: () => {},
    },
    BrowserWindow: class {
      loadFile() {}
      on() {}
      isDestroyed() { return false; }
      isMinimized() { return false; }
      restore() {}
      focus() {}
      static getAllWindows() { return []; }
    },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {
      trashItem: async (p) => {
        trashed.push(p);
        await fsp.rm(p, { recursive: true, force: true });
      },
    },
  };
}

// Возвращает { call, sent, trashed, userData }.
// call(channel, args) вызывает обработчик так же, как это делает preload.
async function loadMain() {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-ud-'));
  const handlers = new Map();
  const trashed = [];
  const sent = [];

  const electronPath = require.resolve('electron', { paths: [APP_ROOT] });
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: electronStub(userData, handlers, trashed),
  };

  const mainPath = require.resolve(path.join(APP_ROOT, 'main.js'));
  delete require.cache[mainPath];
  require(mainPath);

  const event = { sender: { send: (ch, payload) => sent.push({ ch, payload }) } };
  const call = (channel, args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`нет обработчика: ${channel}`);
    return fn(event, args);
  };
  return { call, sent, trashed, userData };
}

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-ipc-'));

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

// Снимок дерева со содержимым файлов — для сравнения сторон целиком.
async function snapshot(root, rel = '', out = []) {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push(`${r}/`);
      await snapshot(root, r, out);
    } else {
      out.push(`${r}=${await fsp.readFile(path.join(root, r), 'utf8')}`);
    }
  }
  return out.sort();
}

module.exports = { loadMain, tmpDir, writeFile, snapshot };
