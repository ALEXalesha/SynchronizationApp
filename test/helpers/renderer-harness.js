'use strict';

// Поднимает renderer.js в изолированном контексте с крошечной заглушкой DOM.
// Модель выбора (трёхпозиционные отметки, наследование, регистр) — самая
// нагруженная логика интерфейса, и до этой заглушки её нельзя было проверить
// ничем, кроме кликов руками.

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', '..', 'renderer', 'renderer.js');

class El {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._cls = new Set();
    this._listeners = {};
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.classList = {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      toggle: (c, on) => (on ? this._cls.add(c) : this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  closest() { return null; }
}

// const/let в скрипте не попадают на глобальный объект, поэтому дописываем
// эпилог, который выкладывает наружу то, что нужно тестам.
const EPILOGUE = `
var __api = {
  state, toggleCheck, collectSelection, isIncluded, nodeCheckState, pruneMarks,
  onSelectAll, markKey, inheritedIncluded, hasDescendantMark, updateControls,
  metaFor, mergeSizes, sortNodes, formatSize, escapeHtml,
};`;

const idleApi = {
  getSettings: async () => ({}),
  saveSettings: async () => {},
  listFolders: async () => ({ items: [], localOk: true, networkOk: true }),
  probe: async () => ({ localOk: true, networkOk: true }),
  startCrawl: async () => {},
  stopCrawl: async () => {},
  onCrawl: () => () => {},
  onSyncProgress: () => () => {},
  onPreviewProgress: () => () => {},
};

function loadRenderer(api = idleApi) {
  const byId = new Map();
  const document = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new El());
      return byId.get(id);
    },
    createElement: (t) => new El(t),
    querySelector: () => new El(),
    querySelectorAll: (sel) => {
      if (sel.includes('list-head')) {
        return ['local', 'network'].map((side) => {
          const e = new El();
          e.dataset.side = side;
          return e;
        });
      }
      if (sel.includes('select-all')) return [new El(), new El()];
      return [];
    },
  };

  const ctx = {
    document,
    window: { api },
    console,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    Date, Math, Map, Set, JSON, Array, Object, String, Number, Promise, Error,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RENDERER, 'utf8') + EPILOGUE, ctx, { filename: 'renderer.js' });

  const inner = ctx.__api;
  // Массивы, рождённые внутри контекста, принадлежат другому набору intrinsics,
  // и deepStrictEqual отвергает их по прототипу, даже когда содержимое совпадает.
  // Приводим к массивам этого контекста прямо на границе.
  return {
    ...inner,
    collectSelection: () => {
      const { folders, excludes } = inner.collectSelection();
      return { folders: Array.from(folders), excludes: Array.from(excludes) };
    },
    sortNodes: (nodes) => Array.from(inner.sortNodes(nodes)),
  };
}

// Узел дерева в том виде, в каком его строит makeNode.
const node = (relPath, isDir = true) => ({
  relPath,
  name: relPath.split('/').pop(),
  isDir,
  hasLocal: true,
  hasNetwork: true,
});

module.exports = { loadRenderer, node };
