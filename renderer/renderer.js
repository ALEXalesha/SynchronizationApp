'use strict';

// ---- Состояние ----
const state = {
  localPath: '',
  networkPath: '',
  direction: 'toNetwork', // 'toNetwork' | 'toLocal'
  roots: [], // дерево узлов верхнего уровня
  // ключ(relPath) -> { path, mark: 'include' | 'exclude' } (только неизбыточные метки)
  marks: new Map(),
  expanded: new Set(), // relPath развёрнутых узлов
  sizeMap: new Map(), // ключ(relPath) -> { sizeLocal, cntLocal, sizeNetwork, cntNetwork }
  scanGen: 0,
  localOk: null, // доступность папок (постоянная проверка)
  networkOk: null,
  sort: 'name', // 'name' | 'date'
  sizeMode: 'capped', // 'off' | 'capped' (до 300k) | 'full' (без лимита)
};

// Узел: { name, relPath, isDir, hasLocal, hasNetwork, loaded, loading, children }
function makeNode(dto) {
  return {
    name: dto.name,
    relPath: dto.relPath,
    isDir: dto.isDir,
    hasLocal: dto.hasLocal,
    hasNetwork: dto.hasNetwork,
    mtimeMs: dto.mtimeMs || 0,
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
  sortMode: document.getElementById('sortMode'),
  sizeMode: document.getElementById('sizeMode'),
  progressBar: document.querySelector('.progress-bar'),
  sbDot: document.getElementById('sbDot'),
  sbText: document.getElementById('sbText'),
  sbSummary: document.getElementById('sbSummary'),
  sbBar: document.getElementById('sbBar'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  previewSummary: document.getElementById('previewSummary'),
  previewList: document.getElementById('previewList'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  cancelBtn: document.getElementById('cancelBtn'),
  confirmBtn: document.getElementById('confirmBtn'),
  historyBtn: document.getElementById('historyBtn'),
  historyModal: document.getElementById('historyModal'),
  historyList: document.getElementById('historyList'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  historyCloseBtn: document.getElementById('historyCloseBtn'),
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
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  // Без ограничения сверху шкала кончается раньше числа, и размер шары
  // на несколько петабайт печатался как «2 undefined».
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
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
  el.sbBar.hidden = kind !== 'busy'; // бегущая полоска только во время загрузки
}

// ---- Модель выбора (трёхпозиционная) ----
// Ключ отметки — путь без учёта регистра, как и всюду в главном процессе.
// Имя узла в дереве берётся с той стороны, что попала в список первой, и стоит
// второй написать его иначе ('Отчёты' против 'отчёты'), как точный ключ переставал
// совпадать: галочка с папки пропадала сама собой, а вместе с ней и папка из
// синхронизации. Хранится при этом настоящее написание — его и отправляем дальше.
function markKey(relPath) {
  return relPath.toLowerCase();
}
// Раскрытые ветки помним тем же ключом, что и отметки, и по той же причине.
// Имя папки берётся с той стороны, что попала в список первой: пока локальная
// сторона недоступна, оно приходит с сетевой, а когда она возвращается — 'док'
// сменяется на 'Док'. Точный ключ этого не переживал: раскрытая ветка схлопывалась
// сама собой каждые шесть секунд, стоило связи моргнуть.
function expandKey(relPath) {
  return relPath.toLowerCase();
}
function isExpanded(relPath) {
  return state.expanded.has(expandKey(relPath));
}
function inheritedIncluded(relPath) {
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const m = state.marks.get(markKey(parts.slice(0, i).join('/')));
    if (m) return m.mark === 'include';
  }
  return false;
}
function isIncluded(relPath) {
  const m = state.marks.get(markKey(relPath));
  if (m) return m.mark === 'include';
  return inheritedIncluded(relPath);
}
function hasDescendantMark(relPath) {
  const prefix = markKey(relPath) + '/';
  for (const k of state.marks.keys()) {
    if (k.startsWith(prefix)) return true;
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
    sort: state.sort,
    sizeMode: state.sizeMode,
  });
}

// Запускает фоновый обход с учётом режима размеров (с лимитом/без).
function startCrawlIfEnabled() {
  if (state.sizeMode === 'off') {
    setStatus('idle', 'Размеры отключены');
    return;
  }
  setStatus('busy', 'Загрузка размеров и файлов…', '');
  window.api.startCrawl({
    localPath: state.localPath,
    networkPath: state.networkPath,
    noLimit: state.sizeMode === 'full',
  });
}

// Сортировка узлов: папки всегда сверху, внутри — по имени или по дате (новые сверху).
function sortNodes(nodes) {
  const arr = [...nodes];
  arr.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (state.sort === 'date') return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    return a.name.localeCompare(b.name);
  });
  return arr;
}

// Отсортированные дети узла с кешем — чтобы не пересортировывать большие папки
// на каждом рендере. Кеш сбрасывается при смене сортировки или перезагрузке детей.
function sortedChildren(node) {
  if (node._sortKey !== state.sort || !node._sorted) {
    node._sorted = sortNodes(node.children);
    node._sortKey = state.sort;
  }
  return node._sorted;
}
let sortedRootsCache = null;
let sortedRootsKey = null;
function sortedRoots() {
  if (sortedRootsKey !== state.sort || !sortedRootsCache) {
    sortedRootsCache = sortNodes(state.roots);
    sortedRootsKey = state.sort;
  }
  return sortedRootsCache;
}
function invalidateRootSort() {
  sortedRootsCache = null;
}

el.sortMode.addEventListener('change', () => {
  const prev = state.sort;
  state.sort = el.sortMode.value;
  persist();
  // Для сортировки по дате нужно подтянуть даты (по имени они не грузятся).
  if (state.sort === 'date' && prev !== 'date') refresh({ force: false });
  else renderTree();
});

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

// Убирает отметки папок, которых больше нет на верхнем уровне.
// Только по достоверному списку: недоступная сторона отдаёт пусто, и её папки
// выглядят удалёнными. Стереть по такому списку значит потерять выбор из-за
// одного моргнувшего соединения — а список обновляется каждые 6 секунд.
//
// Заодно подгоняем написание корневого сегмента под текущий список. Имя папки
// берётся с той стороны, что попала в список первой, и пока локальная сторона
// была недоступна, оно приходило с сетевой. Когда она возвращается, 'Док'
// сменяется на 'док' — и отметка, ключ которой остался прежним, разом и пропадала
// отсюда, и переставала совпадать со строкой в дереве.
function pruneMarks({ localOk, networkOk }) {
  if (state.localPath && !localOk) return;
  if (state.networkPath && !networkOk) return;

  const byLower = new Map(state.roots.map((n) => [markKey(n.relPath), n.relPath]));
  const kept = new Map();
  for (const entry of state.marks.values()) {
    // Режем по настоящему пути, а не по ключу: приведение регистра у отдельных
    // букв меняет длину строки, и отрезанное по ключу «начало» пришлось бы
    // не на границу сегмента.
    const slash = entry.path.indexOf('/');
    const head = slash < 0 ? entry.path : entry.path.slice(0, slash);
    const actual = byLower.get(markKey(head));
    if (!actual) continue; // папки больше нет — отметку тоже убираем
    const relPath = actual + entry.path.slice(head.length);
    kept.set(markKey(relPath), { path: relPath, mark: entry.mark });
  }
  state.marks = kept;
}

// ---- Загрузка дерева ----
async function refresh({ force = false } = {}) {
  if (!state.localPath && !state.networkPath) return;
  const gen = ++state.scanGen;

  state.expanded.clear();
  setStatus('busy', 'Читаю список папок…');

  let listing;
  try {
    listing = await window.api.listFolders({
      localPath: state.localPath,
      networkPath: state.networkPath,
      relPath: '',
      force,
      needMtime: state.sort === 'date',
    });
  } catch (err) {
    setStatus('error', 'Не удалось прочитать папки', err.message || '');
    return;
  }
  if (gen !== state.scanGen) return;

  state.roots = listing.items.map(makeNode);
  invalidateRootSort();
  pruneMarks(listing);

  renderTree();

  // Фоновая загрузка размеров и файлов (не блокирует интерфейс).
  startCrawlIfEnabled();
}

el.sizeMode.addEventListener('change', () => {
  state.sizeMode = el.sizeMode.value;
  persist();
  window.api.stopCrawl(); // на всякий случай гасим текущий обход
  if (state.sizeMode === 'off') {
    state.sizeMap.clear();
    setStatus('idle', 'Размеры отключены');
    renderTree();
  } else {
    startCrawlIfEnabled();
  }
});

async function loadChildren(node) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  renderTree();
  try {
    const { items } = await window.api.listFolders({
      localPath: state.localPath,
      networkPath: state.networkPath,
      relPath: node.relPath,
      needMtime: state.sort === 'date',
    });
    node.children = items.map(makeNode);
    node._sorted = null; // дети изменились — пересортировать
    node.loaded = true;
  } catch {
    // Запрос не дошёл (окно перезагружают, сторона отвалилась). Молчать нельзя:
    // без этой ветки исключение улетало наружу, перерисовки не происходило,
    // и на строке навсегда оставался крутящийся значок загрузки. Ветка просто
    // остаётся нераскрытой — следующий клик попробует снова.
    state.expanded.delete(expandKey(node.relPath));
  } finally {
    node.loading = false;
  }
  renderTree();
}

// ---- Развернуть / свернуть (только для папок) ----
async function toggleExpand(node) {
  if (!node.isDir) return;
  if (isExpanded(node.relPath)) {
    state.expanded.delete(expandKey(node.relPath));
    renderTree();
    return;
  }
  state.expanded.add(expandKey(node.relPath));
  if (!node.loaded) await loadChildren(node);
  else renderTree();
}

// ---- Отметка (клик переключает включённость целиком; работает и для файлов) ----
function toggleCheck(node) {
  const rel = node.relPath;
  const key = markKey(rel);
  // Узел с отметками внутри рисуется чёрточкой независимо от того, отмечен ли
  // он сам, — и клик по чёрточке всегда включает ветку целиком, как в любом
  // трёхпозиционном списке. Решение принималось по внутреннему состоянию,
  // которого на экране не видно: две одинаковые с виду чёрточки вели себя
  // противоположно — у отмеченной ветки со снятой подпапкой клик разом стирал
  // весь выбор, у неотмеченной с выбранной подпапкой — включал ветку.
  const want = hasDescendantMark(rel) ? true : !isIncluded(rel);
  const inherited = inheritedIncluded(rel);

  const prefix = key + '/';
  for (const k of [...state.marks.keys()]) {
    if (k !== key && k.startsWith(prefix)) state.marks.delete(k);
  }
  if (want === inherited) state.marks.delete(key);
  else state.marks.set(key, { path: rel, mark: want ? 'include' : 'exclude' });
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

  // Верхний уровень режем тем же пределом, что и вложенные: корень с десятками
  // тысяч подпапок иначе строил бы столько же строк DOM на каждую перерисовку,
  // а во время обхода она идёт раз в 400 мс — окно вставало намертво.
  // Отметки при этом живут в state.marks, поэтому «Выбрать все» покрывает и
  // непоказанные папки.
  const roots = sortedRoots();
  walk(roots.slice(0, CHILD_LIMIT), 0);
  if (roots.length > CHILD_LIMIT) {
    appendPlaceholder(`…ещё ${fmtNum(roots.length - CHILD_LIMIT)} (не показаны)`, 0);
  }
  el.localList.scrollTop = lScroll;
  el.networkList.scrollTop = rScroll;
  updateControls();
}

const CHILD_LIMIT = 500;

// Принимает уже отсортированный массив узлов (кеш сортировки — в sortedRoots/sortedChildren).
function walk(sorted, depth) {
  for (const node of sorted) {
    el.localList.appendChild(buildRow(node, depth, 'local'));
    el.networkList.appendChild(buildRow(node, depth, 'network'));

    if (node.isDir && isExpanded(node.relPath) && node.loaded) {
      if (node.children.length === 0) {
        appendPlaceholder('(пусто)', depth + 1);
      } else {
        const kids = sortedChildren(node); // отсортировано и закешировано
        const shown = kids.slice(0, CHILD_LIMIT);
        walk(shown, depth + 1);
        const hidden = kids.length - shown.length;
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
  const s = state.sizeMap.get(markKey(node.relPath));
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
    caret.textContent = isExpanded(node.relPath) ? '▾' : '▸';
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
    state.roots.forEach((n) => state.marks.set(markKey(n.relPath), { path: n.relPath, mark: 'include' }));
  }
  renderTree();
}
el.selectAlls.forEach((box) => box.addEventListener('change', onSelectAll));

function updateControls() {
  const { folders, excludes } = collectSelection();
  const exNote = excludes.length ? `, исключено: ${excludes.length}` : '';
  const allChecked =
    state.roots.length > 0 &&
    state.roots.every((n) => {
      const m = state.marks.get(markKey(n.relPath));
      return !!m && m.mark === 'include';
    });

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
  for (const entry of state.marks.values()) {
    if (entry.mark === 'include') folders.push(entry.path);
    else excludes.push(entry.path);
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
// Ключ — тот же, что у отметок: без учёта регистра. Обход присылает путь
// с той стороны, что встретилась первой, а строка в дереве может быть подписана
// написанием другой — при точном ключе размер к ней просто не находился.
// На диске от прежних версий лежит кеш со старыми ключами: приведение здесь
// разбирает и его, поэтому отдельная миграция не нужна.
function mergeSizes(entries) {
  for (const e of entries) {
    const key = markKey(e.relPath);
    const cur =
      state.sizeMap.get(key) ||
      { sizeLocal: null, cntLocal: null, sizeNetwork: null, cntNetwork: null };
    if (e.sizeLocal != null) {
      cur.sizeLocal = e.sizeLocal;
      cur.cntLocal = e.cntLocal;
    }
    if (e.sizeNetwork != null) {
      cur.sizeNetwork = e.sizeNetwork;
      cur.cntNetwork = e.cntNetwork;
    }
    state.sizeMap.set(key, cur);
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
  onDone: ({ scanned, ok, toobig, partial, noAccess }) => {
    // partial — сторона пропала посреди обхода. Размеры показать можно, но они
    // неполные, и молчаливое «Готово» выдало бы их за полную картину.
    // noAccess — другое: папки на месте, но внутрь не пускают. Звать чинить
    // связь тут незачем, а знать про пропуск всё равно нужно.
    if (ok && !partial && noAccess)
      setStatus('done', `Готово, ${noAccess} папок без доступа`, `${fmtNum(scanned)} объектов`);
    else if (ok && partial)
      setStatus('error', 'Связь оборвалась — размеры неполные, нажмите «Обновить»', `${fmtNum(scanned)} объектов`);
    else if (ok) setStatus('done', 'Готово', `${fmtNum(scanned)} объектов`);
    else if (toobig)
      setStatus('error', 'Слишком много файлов — подсчёт размеров остановлен', `${fmtNum(scanned)}+`);
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
  el.progressText.textContent = ''; // сброс прошлого «Готово …»
  el.progressFill.style.width = '0%';
  el.confirmBtn.disabled = true;
  el.confirmBtn.textContent = 'Выполнить';
  el.cancelBtn.disabled = false;
  confirmMode = 'run';
  el.modal.hidden = false;

  // Общее число файлов при сканировании заранее неизвестно, поэтому показываем
  // «бегущую» полоску активности (индикатор, что процесс идёт).
  el.progressWrap.hidden = false;
  el.progressBar.classList.add('indeterminate');
  el.progressFill.style.width = '';

  // Живой счётчик просканированных файлов.
  const unsub = window.api.onPreviewProgress(({ scanned }) => {
    el.previewSummary.innerHTML = `<div class="empty">Сканирую выбранное… ${scanned.toLocaleString('ru-RU')} файлов</div>`;
  });

  let result;
  try {
    result = await window.api.preview({
      localPath: state.localPath,
      networkPath: state.networkPath,
      folders,
      excludes,
      direction: state.direction,
    });
  } catch (err) {
    result = { error: err.message };
  } finally {
    unsub();
    el.progressBar.classList.remove('indeterminate');
    el.progressWrap.hidden = true;
    el.progressFill.style.width = '0%';
  }

  if (result.aborted) return; // окно уже закрыто отменой
  if (result.error) {
    el.previewSummary.innerHTML = `<div class="empty">Не удалось просканировать: ${escapeHtml(result.error)}.<br>Проверьте связь с сетевой папкой и повторите.</div>`;
    el.previewList.innerHTML = '';
    el.confirmBtn.disabled = true;
    return;
  }

  renderPreview(result);
  el.confirmBtn.disabled = result.totals.total === 0;
}

let lastPreviewTotals = { move: 0, copy: 0, overwrite: 0, trash: 0, dirs: 0 };
function renderPreview({ perFolder, totals, destTrashable, skipped = [], skippedTotal = 0 }) {
  lastPreviewTotals = totals;
  const dirLabel = state.direction === 'toNetwork' ? 'Локально → Сеть' : 'Сеть → Локально';
  const delLabel = destTrashable ? 'в Корзину' : 'удалить';
  const warn =
    !destTrashable && totals.trash > 0
      ? '<div class="preview-warn">⚠ На сетевой папке нет Корзины — лишние файлы будут удалены безвозвратно.</div>'
      : '';
  // Перемещения показываем только когда они есть: в обычном прогоне их ноль,
  // и лишняя плашка только мешала бы.
  const moveStat = totals.move
    ? `<div class="stat move"><span class="num">${totals.move}</span><span class="lbl">переместить</span></div>`
    : '';
  const dirsNote = totals.dirs
    ? `<div class="preview-note">Папок привести в порядок: ${totals.dirs}</div>`
    : '';
  // Папки, закрытые правами. Их содержимое не сравнивается ни на одной стороне,
  // поэтому оно останется как есть — и сказать об этом надо до запуска, а не
  // оставлять пользователя гадать, почему ветка не синхронизируется.
  const skipNote = skippedTotal
    ? `<div class="preview-warn">⚠ Нет доступа к ${skippedTotal} папкам — их содержимое не тронуто ни на одной стороне:<br>${skipped
        .map((p) => escapeHtml(p))
        .join('<br>')}${skippedTotal > skipped.length ? '<br>…' : ''}</div>`
    : '';
  el.previewSummary.innerHTML = `
    ${moveStat}
    <div class="stat copy"><span class="num">${totals.copy}</span><span class="lbl">скопировать</span></div>
    <div class="stat overwrite"><span class="num">${totals.overwrite}</span><span class="lbl">перезаписать</span></div>
    <div class="stat trash"><span class="num">${totals.trash}</span><span class="lbl">${delLabel}</span></div>
    ${dirsNote}${warn}${skipNote}`;

  el.previewList.innerHTML =
    `<li class="pv-head" style="color:var(--text-dim);font-size:12px">${dirLabel}</li>` +
    perFolder
      .map((pf) => {
        const s = pf.summary;
        const parts = [];
        if (s.move) parts.push(`→${s.move}`);
        if (s.copy) parts.push(`+${s.copy}`);
        if (s.overwrite) parts.push(`~${s.overwrite}`);
        if (s.trash) parts.push(`−${s.trash}`);
        const counts = parts.length ? parts.join('  ') : 'без изменений';
        return `<li><span>${escapeHtml(pf.folder)}</span><span class="pv-counts">${counts}</span></li>`;
      })
      .join('');
}

// Во время работы левая кнопка превращается в «Остановить»: главный процесс
// прекращает работу и откатывает уже сделанное по журналу.
let syncRunning = false;
el.cancelBtn.addEventListener('click', () => {
  if (syncRunning) {
    el.cancelBtn.disabled = true;
    el.cancelBtn.textContent = 'Останавливаю…';
    el.progressText.textContent = 'Останавливаю и возвращаю всё как было…';
    el.progressBar.classList.add('indeterminate');
    window.api.cancelSync();
    return;
  }
  window.api.cancelPreview(); // остановить идущий скан, если он есть
  el.modal.hidden = true;
  if (confirmMode === 'close') {
    // Синхронизация уже прошла — список на экране устарел.
    confirmMode = 'run';
    refresh({ force: true });
  }
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

const ACTION_VERB = {
  move: 'перемещаю',
  copy: 'копирую',
  overwrite: 'обновляю',
  trash: 'убираю',
  mkdir: 'создаю папку',
  rmdir: 'убираю папку',
  rollback: 'возвращаю как было',
};

async function runSync() {
  syncRunning = true;
  el.confirmBtn.disabled = true;
  el.cancelBtn.disabled = false;
  el.cancelBtn.textContent = 'Остановить';
  el.progressWrap.hidden = false;
  el.progressBar.classList.remove('indeterminate');
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Начинаю…';

  // Живой счётчик по действиям — цифры в плашках растут по ходу работы.
  const numEls = {
    move: el.previewSummary.querySelector('.stat.move .num'),
    copy: el.previewSummary.querySelector('.stat.copy .num'),
    overwrite: el.previewSummary.querySelector('.stat.overwrite .num'),
    trash: el.previewSummary.querySelector('.stat.trash .num'),
  };
  const unsubscribe = window.api.onSyncProgress(({ done, total, action, path, by }) => {
    if (action === 'rollback') return; // текст уже показан кнопкой остановки
    const pct = total ? Math.round((done / total) * 100) : 100;
    el.progressFill.style.width = `${pct}%`;
    el.progressText.textContent = `${done}/${total} · ${ACTION_VERB[action] || ''} ${path}`;
    if (by) {
      for (const key of Object.keys(numEls)) {
        if (numEls[key]) numEls[key].textContent = `${by[key]}/${lastPreviewTotals[key]}`;
      }
    }
  });

  try {
    const { folders, excludes } = collectSelection();
    const res = await window.api.sync({
      localPath: state.localPath,
      networkPath: state.networkPath,
      folders,
      excludes,
      direction: state.direction,
    });
    el.progressBar.classList.remove('indeterminate');

    if (res && res.error && !res.started) {
      // Главный процесс отказался начинать (например, сторона недоступна).
      // Важно сказать прямо, что приёмник не тронут: иначе видно только ошибку.
      el.progressFill.style.width = '0%';
      el.progressText.textContent = 'Не начато';
      el.previewSummary.innerHTML = `<div class="preview-warn">⚠ Синхронизация не начиналась: ${escapeHtml(res.error)}.<br>Ничего не изменено. Проверьте связь и повторите.</div>`;
    } else if (res && res.error) {
      // Оборвалось уже на записи. Обещать «ничего не изменено» тут нельзя.
      el.progressText.textContent = 'Прервано ошибкой';
      el.previewSummary.innerHTML = `<div class="preview-warn">⚠ Синхронизация оборвалась: ${escapeHtml(res.error)}.<br>Часть файлов могла быть обработана. Проверьте связь и запустите ещё раз — незавершённое будет разобрано на старте.</div>`;
    } else if (res && res.cancelled) {
      el.progressFill.style.width = '0%';
      el.progressText.textContent = 'Остановлено, всё возвращено как было';
      // Сюда попадают файлы, которые не удалось отложить в служебную папку:
      // удалённые ушли сразу в Корзину, а перезаписанные затёрты копией с источника,
      // и в Корзине их нет вовсе. Обещать одну Корзину на оба случая нельзя.
      const lost = res.unrecoverable
        ? `<div class="preview-warn">⚠ ${res.unrecoverable} файлов вернуть не удалось: их пришлось обработать напрямую (обычно слишком длинный путь). Удалённые ищите в Корзине приёмника; перезаписанные заменены версией с источника.</div>`
        : '';
      el.previewSummary.innerHTML =
        '<div class="preview-note">Синхронизация прервана. Скопированное удалено, перезаписанное и удалённое возвращено на место.</div>' + lost;
    } else {
      const perm = res && res.permanentDeletes ? ` · удалено безвозвратно: ${res.permanentDeletes}` : '';
      // Закрытые правами папки не ошибка и не работа — но и не «всё сделано».
      const skip =
        res && res.skippedTotal
          ? `<div class="preview-note">Пропущено папок без доступа: ${res.skippedTotal}. Их содержимое не тронуто ни на одной стороне.</div>`
          : '';
      if (res && res.failures) {
        el.progressText.textContent = `Готово с ошибками: ${res.failures} файлов не удалось${perm}`;
        const sample = (res.failuresSample || []).map((s) => escapeHtml(s)).join('<br>');
        el.previewSummary.innerHTML = `<div class="preview-warn">⚠ Не удалось обработать ${res.failures} файлов (нет прав или заняты):<br>${sample}${res.failures > 5 ? '<br>…' : ''}</div>${skip}`;
      } else {
        el.progressText.textContent = `Готово ✓${perm}`;
        if (skip) el.previewSummary.innerHTML = skip;
      }
    }
    el.confirmBtn.textContent = 'Закрыть';
    el.confirmBtn.disabled = false;
    confirmMode = 'close';
  } catch (err) {
    // Без этого кнопка «Выполнить» осталась бы заблокированной, и окно
    // закрывалось бы только «Отменой», без обновления списка.
    el.progressText.textContent = `Ошибка: ${err.message}`;
    el.progressBar.classList.remove('indeterminate');
    el.confirmBtn.textContent = 'Закрыть';
    el.confirmBtn.disabled = false;
    confirmMode = 'close';
  } finally {
    syncRunning = false;
    el.cancelBtn.textContent = 'Отмена';
    el.cancelBtn.disabled = false;
    unsubscribe();
  }
}

// ---- История синхронизаций ----
el.historyBtn.addEventListener('click', openHistory);
el.historyCloseBtn.addEventListener('click', () => {
  el.historyModal.hidden = true;
});
el.clearHistoryBtn.addEventListener('click', async () => {
  await window.api.clearHistory();
  renderHistory([]);
});

async function openHistory() {
  el.historyList.innerHTML = '<div class="empty">Загрузка…</div>';
  el.historyModal.hidden = false;
  const list = await window.api.getHistory();
  renderHistory(list);
}

function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return iso;
  }
}

function renderHistory(list) {
  if (!list || list.length === 0) {
    el.historyList.innerHTML =
      '<div class="empty">Пока нет записей — история появится после синхронизации.</div>';
    return;
  }

  el.historyList.innerHTML = list
    .map((run, i) => {
      const dir = run.direction === 'toNetwork' ? 'Локально → Сеть' : 'Сеть → Локально';
      const t = run.totals || { copy: 0, overwrite: 0, trash: 0 };
      const parts = [];
      if (t.move) parts.push(`<span class="hc-move">→${t.move}</span>`);
      if (t.copy) parts.push(`<span class="hc-copy">+${t.copy}</span>`);
      if (t.overwrite) parts.push(`<span class="hc-over">~${t.overwrite}</span>`);
      if (t.trash) parts.push(`<span class="hc-trash">−${t.trash}</span>`);
      const counts = parts.join(' ') || 'без изменений';

      const badges = [];
      if (run.permanentDeletes)
        badges.push(`<span class="hist-badge danger">безвозвратно: ${run.permanentDeletes}</span>`);
      if (run.failures)
        badges.push(`<span class="hist-badge warn">ошибок: ${run.failures}</span>`);

      return `
        <div class="hist-run">
          <div class="hist-head" data-run="${i}">
            <span class="hist-caret">▸</span>
            <span class="hist-time">${escapeHtml(fmtDateTime(run.time))}</span>
            <span class="hist-dir">${dir}</span>
            <span class="hist-counts">${counts}</span>
            ${badges.join(' ')}
          </div>
          <div class="hist-files" hidden></div>
        </div>`;
    })
    .join('');

  el.historyList.querySelectorAll('.hist-head').forEach((head) => {
    head.addEventListener('click', () => {
      const box = head.nextElementSibling;
      const caret = head.querySelector('.hist-caret');
      const wasHidden = box.hidden;
      // Разметку строим только при первом раскрытии. Заранее — значит собрать её
      // разом для всех запусков: при полной истории это до миллиона строк в одной
      // innerHTML, и окно вставало намертво ещё до того, как его показывали.
      if (wasHidden && !box.dataset.filled) {
        box.innerHTML = historyFilesHtml(list[Number(head.dataset.run)]);
        box.dataset.filled = '1';
      }
      box.hidden = !wasHidden;
      caret.textContent = wasHidden ? '▾' : '▸';
    });
  });
}

// Строки файлов одного запуска. Старые записи хранятся без перечня — тогда
// говорим об этом прямо, а не показываем пустоту.
function historyFilesHtml(run) {
  if (!run) return '';
  if (run.detailsDropped) {
    const n = run.fileCount ? ` (${fmtNum(run.fileCount)})` : '';
    return `<div class="hist-file muted">Список файлов${n} не сохранён: подробности хранятся только у последних запусков.</div>`;
  }
  const files = (run.files || [])
    .map((f) => {
      const sym = { trash: '−', overwrite: '~', copy: '+', move: '→' }[f.action] || '';
      return `<div class="hist-file ${f.action}">${sym} ${escapeHtml(f.path)}</div>`;
    })
    .join('');
  const more = run.filesTruncated
    ? `<div class="hist-file muted">…ещё ${run.filesTruncated} (не сохранены)</div>`
    : '';
  return files + more || '<div class="hist-file muted">Файлы не записаны.</div>';
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
  const listing = await window.api.listFolders({
    localPath: state.localPath,
    networkPath: state.networkPath,
    relPath: '',
    needMtime: state.sort === 'date',
  });
  // Сторона не прочиталась — её папки выглядят пропавшими. Подменять список
  // такой половинчатой картиной нельзя: строки замигают «нет в сети», а вернуть
  // их сможет только следующий удачный тик.
  if (state.localPath && !listing.localOk) return;
  if (state.networkPath && !listing.networkOk) return;

  // Сравниваем и ищем узлы по ключу без учёта регистра. Написание имени берётся
  // с той стороны, что попала в список первой, и когда пропадавшая сторона
  // возвращается, 'док' сменяется на 'Док'. Точный ключ принимал это за другую
  // папку: старый узел выбрасывался вместе с загруженными детьми, раскрытая
  // ветка схлопывалась, а подпись строки «менялась» на ровном месте — и так
  // каждые шесть секунд, пока связь моргала.
  const sig = (arr) =>
    arr.map((n) => `${markKey(n.relPath)}:${n.hasLocal ? 1 : 0}${n.hasNetwork ? 1 : 0}`).join('|');
  const oldSig = sig(state.roots);
  const byRel = new Map(state.roots.map((n) => [markKey(n.relPath), n]));
  state.roots = listing.items.map((it) => {
    const ex = byRel.get(markKey(it.relPath));
    if (ex) {
      ex.name = it.name; // написание подтягиваем за листингом
      ex.relPath = it.relPath;
      ex.isDir = it.isDir;
      ex.hasLocal = it.hasLocal;
      ex.hasNetwork = it.hasNetwork;
      ex.mtimeMs = it.mtimeMs || 0; // держим дату свежей для сортировки
      return ex;
    }
    return makeNode(it);
  });
  invalidateRootSort();
  pruneMarks(listing);

  if (oldSig !== sig(state.roots)) renderTree();
  else updateControls();
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

    // Пока открыт предпросмотр, дерево под ним всё равно не видно, а вот сеть
    // общая: refresh заново поднимет обход всех размеров той же шарой, по которой
    // сейчас идёт копирование. Раньше моргнувшая связь этим и оборачивалась —
    // подсчёт размеров вставал вторым потоком поперёк синхронизации. Список
    // обновится сам, когда окно закроют: это делают обе его кнопки.
    if (!el.modal.hidden) return;

    if (changed) {
      // Связь появилась/пропала — обновляем список и пересчитываем размеры.
      // force сбрасывает кеш сканов: пока сторона была недоступна, её папки
      // читались как пустые, и такой скан нельзя пускать в план.
      await refresh({ force: true });
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
  if (s.sort === 'name' || s.sort === 'date') {
    state.sort = s.sort;
    el.sortMode.value = s.sort;
  }
  if (s.sizeMode === 'off' || s.sizeMode === 'capped' || s.sizeMode === 'full') {
    state.sizeMode = s.sizeMode;
  } else if (s.showSizes === false) {
    state.sizeMode = 'off'; // миграция со старой настройки
  }
  el.sizeMode.value = state.sizeMode;
  // Файл настроек мог испортиться (обрыв записи, правка руками). Путь не строкой
  // главный процесс принимает за путь и роняет весь листинг на path.join.
  if (s.direction === 'toNetwork' || s.direction === 'toLocal') setDirection(s.direction);
  if (typeof s.localPath === 'string' && s.localPath) setPath('local', s.localPath);
  if (typeof s.networkPath === 'string' && s.networkPath) setPath('network', s.networkPath);
  if (state.localPath || state.networkPath) await refresh({ force: true });
  probeTick();
  setInterval(probeTick, 6000);
})();
