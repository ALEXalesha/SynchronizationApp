// Место окна между запусками (1.1.0). Тот же модуль, что в калькуляторах
// (Calculators: calcpro-glass/window-state.js) и в Paint Pro; у SyncGlass окно
// постоянного размера, так что запоминается только место.
//
// Правило выбора места - чистые функции без Electron, их проверяют обычные тесты;
// main.js только читает и пишет файл и берёт у Electron рабочие области экранов.
// Что может прийти из файла: окно на отключённом мониторе, размер больше экрана или
// меньше минимума, мусор вместо чисел, пустой или обрезанный файл. Всё это должно
// давать окно, которое видно и за которое можно взяться, а не падение.
'use strict';

const fs = require('fs');
const path = require('path');

// Сколько окна должно оставаться на экране, чтобы за него можно было взяться: полоса
// заголовка высотой 38 (системный заголовок Windows с запасом) и хотя бы 80 по ширине.
const GRIP_HEIGHT = 38;
const GRIP_WIDTH = 80;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * Где и какого размера открыть окно.
 * @param saved   что лежало в файле (что угодно, в том числе null)
 * @param areas   рабочие области экранов {x, y, width, height}, основной первым
 * @param opts    {width, height, minWidth, minHeight} - размер по умолчанию и минимум
 * @returns {{width, height, x?, y?, maximized}} без x и y - Electron поставит окно по центру
 */
function restore(saved, areas, opts) {
  const byDefault = { width: opts.width, height: opts.height, maximized: false };
  const screens = (Array.isArray(areas) ? areas : []).filter((a) =>
    a && finite(a.x) && finite(a.y) && finite(a.width) && finite(a.height) && a.width > 0 && a.height > 0);
  if (!saved || typeof saved !== 'object' || !finite(saved.width) || !finite(saved.height)) return byDefault;

  const maximized = saved.maximized === true;
  // Самый большой экран ограничивает размер сверху: окно, сохранённое на большом
  // мониторе, не должно открыться на маленьком шире экрана.
  const biggest = screens.reduce((m, a) => ({ width: Math.max(m.width, a.width), height: Math.max(m.height, a.height) }),
    { width: opts.width, height: opts.height });
  let width = Math.round(Math.min(Math.max(saved.width, opts.minWidth), Math.max(biggest.width, opts.minWidth)));
  let height = Math.round(Math.min(Math.max(saved.height, opts.minHeight), Math.max(biggest.height, opts.minHeight)));

  if (!finite(saved.x) || !finite(saved.y)) return { width, height, maximized };
  const x = Math.round(saved.x), y = Math.round(saved.y);

  // Экран, на котором больше всего полосы заголовка. Если заголовок не виден ни на одном
  // (монитор отключили, разрешение уменьшили) - окно по центру, размер сохраняется.
  const grip = { x, y, width, height: GRIP_HEIGHT };
  let best = null, bestArea = 0;
  for (const a of screens) {
    const o = overlap(grip, a);
    if (o && o.width * o.height > bestArea) { best = a; bestArea = o.width * o.height; }
  }
  if (!best || bestArea < GRIP_WIDTH * GRIP_HEIGHT / 2) return { width, height, maximized };

  // Окно, чуть съехавшее за край, придвигается к краю своего экрана целиком. Если оно
  // выше экрана (экран ниже минимума окна), прижимается верхом: заголовок важнее низа.
  // Прижимать низом было ошибкой - заголовок уезжал выше экрана (нашло свойство
  // «восстановленное восстанавливается без изменений» на экране 640x481).
  width = Math.min(width, Math.max(best.width, opts.minWidth));
  height = Math.min(height, Math.max(best.height, opts.minHeight));
  const nx = Math.max(best.x, Math.min(x, best.x + best.width - width));
  const ny = Math.max(best.y, Math.min(y, best.y + best.height - height));
  return { x: nx, y: ny, width, height, maximized };
}

/** Что запомнить: обычные границы окна (и у развёрнутого - те, к которым оно вернётся). */
function capture(win) {
  const b = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
}

/** Прочитать файл; нет файла или в нём мусор - null. */
function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Записать файл: сначала во временный, потом переименовать. Если процесс убьют на
 * середине записи, останется старый файл, а не обрезанный.
 */
function save(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; // не записалось - в следующий раз окно просто откроется по умолчанию
  }
}

module.exports = { restore, capture, load, save, GRIP_HEIGHT, GRIP_WIDTH };
