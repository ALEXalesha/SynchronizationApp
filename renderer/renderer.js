'use strict';

// ---- Состояние ----
const state = {
  localPath: '',
  networkPath: '',
  direction: 'toNetwork', // 'toNetwork' | 'toLocal'
  roots: [], // дерево узлов верхнего уровня
  marks: new Map(), // relPath -> 'include' | 'exclude' (только неизбыточные метки)
  expanded: new Set(), // relPath развёрнутых узлов
  sizeMap: new Map(), // relPath -> { sizeLocal, cntLocal, sizeNetwork, cntNetwork }
  scanGen: 0,
  localOk: null, // доступность папок (постоянная проверка)
  networkOk: null,
};

// Узел: { name, relPath, isDir, hasLocal, hasNetwork, loaded, loading, children }
function makeNode(dto) {
  return {
    name: dto.name,
    relPath: dto.relPath,
    isDir: dto.isDir,
    hasLocal: dto.hasLocal,
    hasNetwork: dto.hasNetwork,
    loaded: false,
    loading: false,
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
  refreshBtn: document.getElementById('refreshBtn'),
  syncBtn: document.getElementById('syncBtn'),
  direction: document.getElementById('direction'),
  heads: Array.from(document.querySelectorAll('.list-head[data-side]')),
  selectAlls: Array.from(document.querySelectorAll('.select-all')),
  localConn: document.getElementById('localConn'),
  netConn: document.getElementById('netConn'),
  sbDot: document.getElementById('sbDot'),
  sbText: document.getElementById('sbText'),
  sbSummary: document.getElementById('sbSummary'),
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
function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes === 0) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtNum(n) {
  return n.toLocaleString('ru-RU');
}

// Сторона-источник (там показываем чекбоксы).
function sourceSide() {
  return state.direction === 'toNetwork' ? 'local' : 'network';
}

// ---- Статус-бар ----
function setStatus(kind, text, summary = '') {
  el.sbDot.className = 'sb-dot ' + kind; // busy | done | idle | error
  el.sbText.textContent = text;
  el.sbSummary.textContent = summary;
}

// ---- Модель выбора (трёхпозиционная) ----
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
  state.sizeMap.clear(); // путь сменился — старые размеры больше не годятся
  state.marks.clear();
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
  updateHeads();
  renderTree(); // чекбоксы переезжают на сторону-источник
}
el.direction.addEventListener('click', (e) => {
  const btn = e.target.closest('.dir-btn');
  if (!btn) return;
  setDirection(btn.dataset.dir);
  persist();
});

// Показываем «Выбрать все» только на стороне-источнике, на другой — подсказку.
function updateHeads() {
  const src = sourceSide();
  for (const head of el.heads) {
    const isSrc = head.dataset.side === src;
    head.querySelector('.check-all').style.display = isSrc ? '' : 'none';
    head.querySelector('.selected-count').style.display = isSrc ? '' : 'none';
    head.querySelector('.hint').style.display = isSrc ? 'none' : '';
  }
}

// ---- Загрузка дерева ----
async function refresh({ force = false } = {}) {
  if (!state.localPath && !state.networkPath) return;
  const gen = ++state.scanGen;

  state.expanded.clear();
  setStatus('busy', 'Читаю список папок…');

  const items = await window.api.listFolders({
    localPath: state.localPath,
    networkPath: state.networkPath,
    relPath: '',
    force,
  });
  if (gen !== state.scanGen) return;

  state.roots = items.map(makeNode);

  const rootNames = new Set(state.roots.map((n) => n.relPath));
  for (const key of [...state.marks.keys()]) {
    const top = key.split('/')[0];
    if (!rootNames.has(top)) state.marks.delete(key);
  }

  renderTree();

  // Фоновая загрузка размеров и файлов (не блокирует интерфейс).
  setStatus('busy', 'Загрузка размеров и файлов…', '');
  window.api.startCrawl({ localPath: state.localPath, networkPath: state.networkPath });
}

async function loadChildren(node) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  renderTree();
  try {
    const items = await window.api.listFolders({
      localPath: state.localPath,
      networkPath: state.networkPath,
      relPath: node.relPath,
    });
    node.children = items.map(makeNode);
    node.loaded = true;
  } finally {
    node.loading = false;
  }
  renderTree();
}

// ---- Развернуть / свернуть (только для папок) ----
async function toggleExpand(node) {
  if (!node.isDir) return;
  if (state.expanded.has(node.relPath)) {
    state.expanded.delete(node.relPath);
    renderTree();
    return;
  }
  state.expanded.add(node.relPath);
  if (!node.loaded) await loadChildren(node);
  else renderTree();
}

// ---- Отметка (клик переключает включённость целиком; работает и для файлов) ----
function toggleCheck(node) {
  const rel = node.relPath;
  const want = !isIncluded(rel);
  const inherited = inheritedIncluded(rel);

  for (const k of [...state.marks.keys()]) {
    if (k !== rel && k.startsWith(rel + '/')) state.marks.delete(k);
  }
  if (want === inherited) state.marks.delete(rel);
  else state.marks.set(rel, want ? 'include' : 'exclude');
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

const CHILD_LIMIT = 500;

function walk(nodes, depth) {
  for (const node of nodes) {
    el.localList.appendChild(buildRow(node, depth, 'local'));
    el.networkList.appendChild(buildRow(node, depth, 'network'));

    if (node.isDir && state.expanded.has(node.relPath) && node.loaded) {
      if (node.children.length === 0) {
        appendPlaceholder('(пусто)', depth + 1);
      } else {
        const shown = node.children.slice(0, CHILD_LIMIT);
        walk(shown, depth + 1);
        const hidden = node.children.length - shown.length;
        if (hidden > 0) appendPlaceholder(`…ещё ${hidden}`, depth + 1);
      }
    }
  }
}

function appendPlaceholder(text, depth) {
  const make = () => {
    const li = document.createElement('li');
    li.className = 'folder-row tree-row placeholder';
    li.style.paddingLeft = `${12 + depth * 18}px`;
    li.textContent = text;
    return li;
  };
  el.localList.appendChild(make());
  el.networkList.appendChild(make());
}

// Текст метаданных строки (размер/счёт) для стороны, из sizeMap.
function metaFor(node, side) {
  const present = side === 'local' ? node.hasLocal : node.hasNetwork;
  if (!present) return { text: side === 'local' ? 'нет локально' : 'нет в сети', dim: true };
  const s = state.sizeMap.get(node.relPath);
  if (!s) return { text: '', dim: true };
  const size = side === 'local' ? s.sizeLocal : s.sizeNetwork;
  const cnt = side === 'local' ? s.cntLocal : s.cntNetwork;
  if (size == null) return { text: '', dim: true };
  if (node.isDir) return { text: `${fmtNum(cnt)} файлов · ${formatSize(size)}`, dim: false };
  return { text: formatSize(size), dim: false };
}

function buildRow(node, depth, side) {
  const interactive = side === sourceSide();
  const li = document.createElement('li');
  li.className = 'folder-row tree-row';
  if (!node.isDir) li.classList.add('file-row');
  li.style.paddingLeft = `${12 + depth * 18}px`;

  const present = side === 'local' ? node.hasLocal : node.hasNetwork;
  if (!present) li.classList.add('absent-side');

  // Каретка: у папок всегда, у файлов — пустой отступ.
  const caret = document.createElement('span');
  caret.className = 'caret';
  if (!node.isDir) {
    caret.classList.add('leaf');
  } else if (node.loading) {
    caret.classList.add('mini-spin');
  } else {
    caret.textContent = state.expanded.has(node.relPath) ? '▾' : '▸';
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand(node);
    });
  }
  li.appendChild(caret);

  // Чекбокс — у всего (папки и файлы) на стороне-источнике.
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
  const icon = node.isDir ? '' : '<span class="file-icon">📄</span>';
  const meta = metaFor(node, side);
  info.innerHTML =
    `<span class="folder-name">${icon}${escapeHtml(node.name)}</span>` +
    `<span class="row-meta ${meta.dim ? 'dim' : ''}">${meta.text}</span>`;
  li.appendChild(info);

  if (interactive) {
    li.addEventListener('click', () => toggleCheck(node));
  }
  return li;
}

// ---- Выбор всех ----
function onSelectAll(e) {
  state.marks.clear();
  if (e.target.checked) {
    state.roots.forEach((n) => state.marks.set(n.relPath, 'include'));
  }
  renderTree();
}
el.selectAlls.forEach((box) => box.addEventListener('change', onSelectAll));

function updateControls() {
  const { folders, excludes } = collectSelection();
  const exNote = excludes.length ? `, исключено: ${excludes.length}` : '';
  const allChecked =
    state.roots.length > 0 && state.roots.every((n) => state.marks.get(n.relPath) === 'include');

  for (const head of el.heads) {
    head.querySelector('.selected-count').textContent = `выбрано: ${folders.length}${exNote}`;
  }
  el.selectAlls.forEach((b) => {
    b.checked = allChecked;
  });
  el.syncBtn.disabled = folders.length === 0 || !state.localPath || !state.networkPath;
}

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

// ---- Приём результатов фонового обхода ----
let sizeTimer = null;
function scheduleSizeRender() {
  if (sizeTimer) return;
  sizeTimer = setTimeout(() => {
    sizeTimer = null;
    renderTree();
  }, 400);
}
function mergeSizes(entries) {
  for (const e of entries) {
    const cur =
      state.sizeMap.get(e.relPath) ||
      { sizeLocal: null, cntLocal: null, sizeNetwork: null, cntNetwork: null };
    if (e.sizeLocal != null) {
      cur.sizeLocal = e.sizeLocal;
      cur.cntLocal = e.cntLocal;
    }
    if (e.sizeNetwork != null) {
      cur.sizeNetwork = e.sizeNetwork;
      cur.cntNetwork = e.cntNetwork;
    }
    state.sizeMap.set(e.relPath, cur);
  }
  scheduleSizeRender();
}

window.api.onCrawl({
  onCached: ({ entries }) => {
    mergeSizes(entries);
  },
  onProgress: ({ scanned, entries }) => {
    mergeSizes(entries);
    setStatus('busy', 'Загрузка размеров и файлов…', `${fmtNum(scanned)} объектов`);
  },
  onDone: ({ scanned, ok }) => {
    if (ok) setStatus('done', 'Готово', `${fmtNum(scanned)} объектов`);
    else setStatus('error', 'Не удалось загрузить размеры');
    renderTree();
  },
});

// ---- Предпросмотр и синхронизация ----
el.syncBtn.addEventListener('click', openPreview);

async function openPreview() {
  const { folders, excludes } = collectSelection();
  if (folders.length === 0) return;

  el.modalTitle.textContent = 'Предпросмотр синхронизации';
  el.previewSummary.innerHTML = '<div class="empty">Сканирую выбранное…</div>';
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

let confirmMode = 'run';
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

// ---- Постоянная проверка доступности папок ----
function setConn(dot, ok, has) {
  if (!has) {
    dot.className = 'conn-dot';
    dot.title = '';
    return;
  }
  dot.className = 'conn-dot ' + (ok ? 'ok' : 'bad');
  dot.title = ok ? 'доступно' : 'недоступно';
}

// Лёгкое обновление верхнего уровня без сброса дерева и размеров:
// обновляет присутствие папок (чинит залипшее «нет в сети»), ловит новые/удалённые.
async function lightRelistTop() {
  if (!state.localPath && !state.networkPath) return;
  const items = await window.api.listFolders({
    localPath: state.localPath,
    networkPath: state.networkPath,
    relPath: '',
  });
  const sig = (arr) =>
    arr.map((n) => `${n.relPath}:${n.hasLocal ? 1 : 0}${n.hasNetwork ? 1 : 0}`).join('|');
  const oldSig = sig(state.roots);
  const byRel = new Map(state.roots.map((n) => [n.relPath, n]));
  state.roots = items.map((it) => {
    const ex = byRel.get(it.relPath);
    if (ex) {
      ex.isDir = it.isDir;
      ex.hasLocal = it.hasLocal;
      ex.hasNetwork = it.hasNetwork;
      return ex;
    }
    return makeNode(it);
  });
  if (oldSig !== sig(state.roots)) renderTree();
}

let probing = false;
async function probeTick() {
  if (probing || (!state.localPath && !state.networkPath)) return;
  probing = true;
  try {
    const r = await window.api.probe({
      localPath: state.localPath,
      networkPath: state.networkPath,
    });
    setConn(el.localConn, r.localOk, !!state.localPath);
    setConn(el.netConn, r.networkOk, !!state.networkPath);

    const changed =
      (state.networkOk !== null && r.networkOk !== state.networkOk) ||
      (state.localOk !== null && r.localOk !== state.localOk);
    state.networkOk = r.networkOk;
    state.localOk = r.localOk;

    if (changed) {
      // Связь появилась/пропала — обновляем список и пересчитываем размеры.
      await refresh({ force: false });
    } else if (r.localOk || r.networkOk) {
      // Стабильно — дёшево держим список верхнего уровня актуальным.
      await lightRelistTop();
    }
  } catch {
    // сбой запроса (сеть моргнула) — не критично, повторим на следующем тике
  } finally {
    probing = false;
  }
}

// ---- Старт ----
(async function init() {
  updateHeads();
  const s = (await window.api.getSettings()) || {};
  if (s.direction) setDirection(s.direction);
  if (s.localPath) setPath('local', s.localPath);
  if (s.networkPath) setPath('network', s.networkPath);
  if (s.localPath || s.networkPath) await refresh({ force: true });
  probeTick();
  setInterval(probeTick, 6000);
})();
