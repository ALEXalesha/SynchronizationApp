'use strict';

// ---- Состояние ----
const state = {
  localPath: '',
  networkPath: '',
  direction: 'toNetwork', // 'toNetwork' | 'toLocal'
  roots: [], // дерево узлов верхнего уровня
  marks: new Map(), // relPath -> 'include' | 'exclude' (только неизбыточные метки)
  expanded: new Set(), // relPath развёрнутых узлов
  scanGen: 0,
};

// Узел: { name, relPath, hasLocal, hasNetwork, loaded, loading, isLeaf, children }
function makeNode(dto) {
  return {
    name: dto.name,
    relPath: dto.relPath,
    hasLocal: dto.hasLocal,
    hasNetwork: dto.hasNetwork,
    loaded: false,
    loading: false,
    isLeaf: false,
    children: [],
  };
}

// ---- Элементы ----
const el = {
  localPath: document.getElementById('localPath'),
  networkPath: document.getElementById('networkPath'),
  localPathLabel: document.getElementById('localPathLabel'),
  networkPathLabel: document.getElementById('networkPathLabel'),
  localList: document.getElementById('localList'),
  networkList: document.getElementById('networkList'),
  selectAll: document.getElementById('selectAll'),
  selectedCount: document.getElementById('selectedCount'),
  refreshBtn: document.getElementById('refreshBtn'),
  syncBtn: document.getElementById('syncBtn'),
  direction: document.getElementById('direction'),
  scanStatus: document.getElementById('scanStatus'),
  scanStatusText: document.getElementById('scanStatusText'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  previewSummary: document.getElementById('previewSummary'),
  previewList: document.getElementById('previewList'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  cancelBtn: document.getElementById('cancelBtn'),
  confirmBtn: document.getElementById('confirmBtn'),
};

// ---- Утилиты ----
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Индикатор загрузки с учётом нескольких одновременных операций.
let loadingCount = 0;
function beginLoading(text) {
  loadingCount += 1;
  setScanStatus(text);
}
function endLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) setScanStatus('');
}
function setScanStatus(text) {
  if (text) {
    el.scanStatusText.textContent = text;
    el.scanStatus.hidden = false;
  } else {
    el.scanStatus.hidden = true;
  }
}

// ---- Модель выбора (трёхпозиционная) ----
// Включённость наследуется от ближайшего отмеченного предка; по умолчанию — нет.
function inheritedIncluded(relPath) {
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const anc = parts.slice(0, i).join('/');
    const m = state.marks.get(anc);
    if (m) return m === 'include';
  }
  return false;
}
function isIncluded(relPath) {
  const m = state.marks.get(relPath);
  if (m) return m === 'include';
  return inheritedIncluded(relPath);
}
function hasDescendantMark(relPath) {
  for (const k of state.marks.keys()) {
    if (k.startsWith(relPath + '/')) return true;
  }
  return false;
}
// Состояние чекбокса узла: 'checked' | 'unchecked' | 'partial'.
function nodeCheckState(relPath) {
  if (hasDescendantMark(relPath)) return 'partial';
  return isIncluded(relPath) ? 'checked' : 'unchecked';
}

// ---- Настройки ----
function persist() {
  window.api.saveSettings({
    localPath: state.localPath,
    networkPath: state.networkPath,
    direction: state.direction,
  });
}

// ---- Выбор путей ----
async function pickFolder(side) {
  const dir = await window.api.pickFolder();
  if (!dir) return;
  setPath(side, dir);
  persist();
  await refresh({ force: true });
}

function setPath(side, dir) {
  if (side === 'local') {
    state.localPath = dir;
    el.localPath.value = dir;
    el.localPathLabel.textContent = dir || 'путь не выбран';
  } else {
    state.networkPath = dir;
    el.networkPath.value = dir;
    el.networkPathLabel.textContent = dir || 'путь не выбран';
  }
}

document.querySelectorAll('[data-pick]').forEach((btn) => {
  btn.addEventListener('click', () => pickFolder(btn.dataset.pick));
});

// ---- Направление ----
function setDirection(dir) {
  state.direction = dir;
  el.direction.querySelectorAll('.dir-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.dir === dir);
  });
}

el.direction.addEventListener('click', (e) => {
  const btn = e.target.closest('.dir-btn');
  if (!btn) return;
  setDirection(btn.dataset.dir);
  persist();
});

// ---- Загрузка дерева ----
async function refresh({ force = false } = {}) {
  if (!state.localPath && !state.networkPath) return;
  const gen = ++state.scanGen;

  state.expanded.clear(); // на обновлении сворачиваем всё
  setScanStatus('Читаю список папок…');

  const items = await window.api.listFolders({
    localPath: state.localPath,
    networkPath: state.networkPath,
    relPath: '',
    force,
  });
  if (gen !== state.scanGen) return;

  state.roots = items.map(makeNode);

  // Отброс меток, чьей папки больше нет на верхнем уровне (грубая чистка).
  const rootNames = new Set(state.roots.map((n) => n.relPath));
  for (const key of [...state.marks.keys()]) {
    const top = key.split('/')[0];
    if (!rootNames.has(top)) state.marks.delete(key);
  }

  setScanStatus('');
  renderTree();
}

async function loadChildren(node) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  beginLoading(`Загружаю «${node.name}»…`);
  renderTree();

  try {
    const items = await window.api.listFolders({
      localPath: state.localPath,
      networkPath: state.networkPath,
      relPath: node.relPath,
    });
    node.children = items.map(makeNode);
    node.isLeaf = items.length === 0;
    node.loaded = true;
  } finally {
    node.loading = false;
    endLoading();
  }
  renderTree();
}

// ---- Развернуть / свернуть ----
async function toggleExpand(node) {
  if (state.expanded.has(node.relPath)) {
    state.expanded.delete(node.relPath);
    renderTree();
    return;
  }
  state.expanded.add(node.relPath);
  if (!node.loaded) await loadChildren(node);
  else renderTree();
}

// ---- Отметка ветки (клик переключает включённость целиком) ----
function toggleCheck(node) {
  const rel = node.relPath;
  const want = !isIncluded(rel); // новое желаемое состояние ветки
  const inherited = inheritedIncluded(rel);

  // Вложенные метки теперь избыточны — вся ветка следует за этим узлом.
  for (const k of [...state.marks.keys()]) {
    if (k !== rel && k.startsWith(rel + '/')) state.marks.delete(k);
  }

  if (want === inherited) {
    state.marks.delete(rel); // совпадает с унаследованным — метка не нужна
  } else {
    state.marks.set(rel, want ? 'include' : 'exclude');
  }
  renderTree();
}

// ---- Отрисовка дерева ----
function renderTree() {
  const lScroll = el.localList.scrollTop;
  const rScroll = el.networkList.scrollTop;
  el.localList.innerHTML = '';
  el.networkList.innerHTML = '';

  if (state.roots.length === 0) {
    const msg = state.localPath || state.networkPath ? 'Папок не найдено' : 'Выберите папки внизу';
    el.localList.innerHTML = `<li class="empty">${msg}</li>`;
    el.networkList.innerHTML = `<li class="empty">${msg}</li>`;
    updateControls();
    return;
  }

  walk(state.roots, 0);

  el.localList.scrollTop = lScroll;
  el.networkList.scrollTop = rScroll;
  updateControls();
}

function walk(nodes, depth) {
  for (const node of nodes) {
    el.localList.appendChild(buildRow(node, depth, 'local', true));
    el.networkList.appendChild(buildRow(node, depth, 'network', false));
    if (state.expanded.has(node.relPath) && node.loaded) {
      walk(node.children, depth + 1);
    }
  }
}

function buildRow(node, depth, side, interactive) {
  const li = document.createElement('li');
  li.className = 'folder-row tree-row';
  li.style.paddingLeft = `${12 + depth * 18}px`;

  const present = side === 'local' ? node.hasLocal : node.hasNetwork;
  if (!present) li.classList.add('absent-side');

  // Каретка разворачивания.
  const caret = document.createElement('span');
  caret.className = 'caret';
  if (node.loading) {
    caret.classList.add('mini-spin');
  } else if (node.loaded && node.isLeaf) {
    caret.classList.add('leaf');
  } else {
    caret.textContent = state.expanded.has(node.relPath) ? '▾' : '▸';
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand(node);
    });
  }
  li.appendChild(caret);

  // Чекбокс (только левая панель).
  if (interactive) {
    const cs = nodeCheckState(node.relPath);
    if (cs === 'checked') li.classList.add('checked');
    if (cs === 'partial') li.classList.add('partial');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = cs === 'checked';
    box.indeterminate = cs === 'partial';
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCheck(node);
    });
    li.appendChild(box);
  }

  const info = document.createElement('div');
  info.className = 'folder-info';
  const nameTag = present ? '' : side === 'local' ? ' · нет локально' : ' · нет в сети';
  info.innerHTML = `<span class="folder-name">${escapeHtml(node.name)}<span class="side-note">${nameTag}</span></span>`;
  li.appendChild(info);

  // Клик по строке слева = отметить ветку.
  if (interactive) {
    li.addEventListener('click', () => toggleCheck(node));
  }
  return li;
}

// ---- Выбор всех ----
el.selectAll.addEventListener('change', () => {
  state.marks.clear();
  if (el.selectAll.checked) {
    state.roots.forEach((n) => state.marks.set(n.relPath, 'include'));
  }
  renderTree();
});

function updateControls() {
  const { folders, excludes } = collectSelection();
  const exNote = excludes.length ? `, исключено: ${excludes.length}` : '';
  el.selectedCount.textContent = `выбрано: ${folders.length}${exNote}`;
  el.selectAll.checked =
    state.roots.length > 0 && state.roots.every((n) => state.marks.get(n.relPath) === 'include');
  el.syncBtn.disabled = folders.length === 0 || !state.localPath || !state.networkPath;
}

// Метки полностью описывают выбор: 'include' — корни веток, 'exclude' — дырки внутри них.
// (Избыточные метки не хранятся, поэтому каждая include — корень, каждая exclude — дырка.)
function collectSelection() {
  const folders = [];
  const excludes = [];
  for (const [rel, mark] of state.marks) {
    if (mark === 'include') folders.push(rel);
    else excludes.push(rel);
  }
  return { folders, excludes };
}

el.refreshBtn.addEventListener('click', () => refresh({ force: true }));

// ---- Предпросмотр и синхронизация ----
el.syncBtn.addEventListener('click', openPreview);

async function openPreview() {
  const { folders, excludes } = collectSelection();
  if (folders.length === 0) return;

  el.modalTitle.textContent = 'Предпросмотр синхронизации';
  el.previewSummary.innerHTML = '<div class="empty">Сканирую выбранные папки…</div>';
  el.previewList.innerHTML = '';
  el.progressWrap.hidden = true;
  el.confirmBtn.disabled = true;
  el.confirmBtn.textContent = 'Выполнить';
  confirmMode = 'run';
  el.modal.hidden = false;

  const result = await window.api.preview({
    localPath: state.localPath,
    networkPath: state.networkPath,
    folders,
    excludes,
    direction: state.direction,
  });

  renderPreview(result);
  el.confirmBtn.disabled =
    result.totals.copy + result.totals.overwrite + result.totals.trash === 0;
}

function renderPreview({ perFolder, totals }) {
  const dirLabel = state.direction === 'toNetwork' ? 'Локально → Сеть' : 'Сеть → Локально';
  el.previewSummary.innerHTML = `
    <div class="stat copy"><span class="num">${totals.copy}</span><span class="lbl">скопировать</span></div>
    <div class="stat overwrite"><span class="num">${totals.overwrite}</span><span class="lbl">перезаписать</span></div>
    <div class="stat trash"><span class="num">${totals.trash}</span><span class="lbl">в Корзину</span></div>`;

  el.previewList.innerHTML =
    `<li class="pv-head" style="color:var(--text-dim);font-size:12px">${dirLabel}</li>` +
    perFolder
      .map((pf) => {
        const s = pf.summary;
        const parts = [];
        if (s.copy) parts.push(`+${s.copy}`);
        if (s.overwrite) parts.push(`~${s.overwrite}`);
        if (s.trash) parts.push(`−${s.trash}`);
        const counts = parts.length ? parts.join('  ') : 'без изменений';
        return `<li><span>${escapeHtml(pf.folder)}</span><span class="pv-counts">${counts}</span></li>`;
      })
      .join('');
}

el.cancelBtn.addEventListener('click', () => {
  el.modal.hidden = true;
});

// Кнопка подтверждения: запустить синхронизацию или закрыть окно после завершения.
let confirmMode = 'run'; // 'run' | 'close'
el.confirmBtn.addEventListener('click', () => {
  if (confirmMode === 'close') {
    el.modal.hidden = true;
    confirmMode = 'run';
    el.cancelBtn.disabled = false;
    refresh({ force: true });
  } else {
    runSync();
  }
});

async function runSync() {
  el.confirmBtn.disabled = true;
  el.cancelBtn.disabled = true;
  el.progressWrap.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Начинаю…';

  const unsubscribe = window.api.onSyncProgress(({ done, total, action, path }) => {
    const pct = total ? Math.round((done / total) * 100) : 100;
    el.progressFill.style.width = `${pct}%`;
    const verb = { copy: 'копирую', overwrite: 'обновляю', trash: 'в корзину' }[action] || '';
    el.progressText.textContent = `${done}/${total} · ${verb} ${path}`;
  });

  try {
    const { folders, excludes } = collectSelection();
    await window.api.sync({
      localPath: state.localPath,
      networkPath: state.networkPath,
      folders,
      excludes,
      direction: state.direction,
    });
    el.progressText.textContent = 'Готово ✓';
    el.confirmBtn.textContent = 'Закрыть';
    el.confirmBtn.disabled = false;
    confirmMode = 'close';
  } catch (err) {
    el.progressText.textContent = `Ошибка: ${err.message}`;
    el.cancelBtn.disabled = false;
  } finally {
    unsubscribe();
  }
}

// ---- Старт: восстановление сохранённых путей ----
(async function init() {
  const s = (await window.api.getSettings()) || {};
  if (s.direction) setDirection(s.direction);
  if (s.localPath) setPath('local', s.localPath);
  if (s.networkPath) setPath('network', s.networkPath);
  if (s.localPath || s.networkPath) await refresh({ force: true });
})();
