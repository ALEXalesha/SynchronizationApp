'use strict';

// Модель выбора в дереве: трёхпозиционные отметки, наследование, регистр.
// Отсюда уходят `folders` и `excludes` в главный процесс, поэтому ошибка здесь
// означает синхронизацию не того, что отметил пользователь.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadRenderer, node } = require('./helpers/renderer-harness');

// Каждому тесту — свой контекст: renderer.js держит состояние в модуле.
function fresh() {
  const api = loadRenderer();
  const selection = () => {
    const { folders, excludes } = api.collectSelection();
    return { folders: folders.sort(), excludes: excludes.sort() };
  };
  return { api, selection };
}

test('отмеченная папка попадает в выбор', () => {
  const { api, selection } = fresh();
  api.toggleCheck(node('док'));
  assert.deepStrictEqual(selection(), { folders: ['док'], excludes: [] });
});

test('снятая внутри ветки подпапка становится исключением', () => {
  const { api, selection } = fresh();
  api.toggleCheck(node('док'));
  api.toggleCheck(node('док/архив'));
  assert.deepStrictEqual(selection(), { folders: ['док'], excludes: ['док/архив'] });
  assert.strictEqual(api.isIncluded('док/архив/файл.txt'), false);
});

test('самая точная отметка главнее: вложенная часть внутри исключённой', () => {
  const { api, selection } = fresh();
  api.toggleCheck(node('док'));
  api.toggleCheck(node('док/архив'));
  api.toggleCheck(node('док/архив/2024'));
  assert.deepStrictEqual(selection(), {
    folders: ['док', 'док/архив/2024'],
    excludes: ['док/архив'],
  });
  assert.strictEqual(api.isIncluded('док/архив/2024/отчёт.txt'), true);
  assert.strictEqual(api.isIncluded('док/архив/прочее.txt'), false);
});

// Чёрточка рисуется одинаково и когда ветка отмечена со снятой подпапкой,
// и когда отмечена только подпапка. Клик по ней обязан вести себя одинаково:
// раньше в первом случае он разом стирал весь выбор, а во втором — включал ветку.
test('клик по «частичному» узлу включает ветку целиком в обоих случаях', () => {
  const a = fresh();
  a.api.toggleCheck(node('док'));
  a.api.toggleCheck(node('док/архив'));
  assert.strictEqual(a.api.nodeCheckState('док'), 'partial');
  a.api.toggleCheck(node('док'));
  assert.deepStrictEqual(a.selection(), { folders: ['док'], excludes: [] });

  const b = fresh();
  b.api.toggleCheck(node('док/архив'));
  assert.strictEqual(b.api.nodeCheckState('док'), 'partial');
  b.api.toggleCheck(node('док'));
  assert.deepStrictEqual(b.selection(), { folders: ['док'], excludes: [] });
});

test('повторный клик по отмеченной ветке снимает выбор', () => {
  const { api, selection } = fresh();
  api.toggleCheck(node('док'));
  api.toggleCheck(node('док'));
  assert.deepStrictEqual(selection(), { folders: [], excludes: [] });
});

// Имя узла берётся с той стороны, что попала в список первой. Если вторая пишет
// его иначе, точный ключ переставал совпадать — галочка пропадала сама собой.
test('отметка находится независимо от написания пути', () => {
  const { api } = fresh();
  api.toggleCheck(node('Док'));
  assert.strictEqual(api.isIncluded('док'), true);
  assert.strictEqual(api.isIncluded('ДОК/внутри/ф.txt'), true);
});

test('исключение в другом написании ложится на ту же ветку', () => {
  const { api, selection } = fresh();
  api.toggleCheck(node('Док'));
  api.toggleCheck(node('док/Архив'));
  assert.deepStrictEqual(selection(), { folders: ['Док'], excludes: ['док/Архив'] });
  assert.strictEqual(api.isIncluded('ДОК/архив/ф.txt'), false);
});

test('клик по тому же узлу в другом регистре снимает отметку, а не заводит вторую', () => {
  const { api } = fresh();
  api.toggleCheck(node('Отчёт'));
  api.toggleCheck(node('отчёт'));
  assert.strictEqual(api.state.marks.size, 0);
});

test('отметка исчезнувшей папки убирается, написание корня подгоняется', () => {
  const { api, selection } = fresh();
  api.state.roots = [node('Док')];
  api.toggleCheck(node('док'));
  api.toggleCheck(node('док/внутри'));
  api.toggleCheck(node('пропала'));
  api.pruneMarks({ localOk: true, networkOk: true });
  assert.deepStrictEqual(selection(), { folders: ['Док'], excludes: ['Док/внутри'] });
});

// Недоступная сторона отдаёт пустой список, и её папки выглядят удалёнными.
// Чистить по такому списку — значит потерять выбор из-за одного моргания связи.
test('моргнувшая связь не стирает отметки', () => {
  const { api, selection } = fresh();
  api.state.localPath = 'C:/local';
  api.state.networkPath = '\\\\srv\\share';
  api.state.roots = [];
  api.toggleCheck(node('док'));
  api.pruneMarks({ localOk: false, networkOk: true });
  assert.deepStrictEqual(selection(), { folders: ['док'], excludes: [] });
});

test('«Выбрать все» и «Снять все»', () => {
  const { api, selection } = fresh();
  api.state.roots = [node('a'), node('b'), node('c')];
  api.onSelectAll({ target: { checked: true } });
  assert.deepStrictEqual(selection().folders, ['a', 'b', 'c']);
  api.toggleCheck(node('b'));
  assert.deepStrictEqual(selection().folders, ['a', 'c']);
  api.onSelectAll({ target: { checked: false } });
  assert.deepStrictEqual(selection(), { folders: [], excludes: [] });
});

test('состояние узлов вокруг глубокого исключения', () => {
  const { api } = fresh();
  api.toggleCheck(node('п'));
  api.toggleCheck(node('п/q/r/s'));
  assert.strictEqual(api.nodeCheckState('п'), 'partial');
  assert.strictEqual(api.nodeCheckState('п/q/r'), 'partial');
  assert.strictEqual(api.nodeCheckState('п/q/сосед'), 'checked');
  assert.strictEqual(api.isIncluded('п/q/r'), true);
  assert.strictEqual(api.isIncluded('п/q/r/s/глубже.txt'), false);
});

// Опознание «внутри есть отметки» рисует чёрточку у каждой строки, и раньше оно
// перебирало все отметки на каждую строку. Два предела перемножались: «Выбрать
// все» на папке с 30 тысячами узлов и 500 строк на экране давали треть секунды
// на перерисовку, а во время фонового обхода дерево перерисовывается раз в 400 мс.
test('чёрточки не платят произведением строк на отметки', () => {
  const { api } = fresh();
  const roots = [];
  for (let i = 0; i < 30000; i += 1) roots.push(node(`снимок${i}.jpg`, false));
  api.state.roots = roots;
  api.onSelectAll({ target: { checked: true } });

  const started = Date.now();
  for (let i = 0; i < 500; i += 1) api.nodeCheckState(`снимок${i}.jpg`);
  const spent = Date.now() - started;

  assert.strictEqual(api.nodeCheckState('снимок0.jpg'), 'checked');
  assert.ok(spent < 100, `500 строк заняли ${spent} мс — похоже на перебор всех отметок`);
});

// Ответ на «есть ли отметки внутри» теперь считается один раз и запоминается,
// поэтому каждая правка отметок обязана этот ответ сбрасывать. Пропущенный сброс
// показал бы чёрточку там, где выбора уже нет, и наоборот.
test('запомненный ответ про отметки внутри сбрасывается на каждой правке', () => {
  const { api } = fresh();
  api.state.roots = [node('док'), node('фото')];

  assert.strictEqual(api.hasDescendantMark('док'), false);
  api.toggleCheck(node('док'));
  api.toggleCheck(node('док/архив'));
  assert.strictEqual(api.hasDescendantMark('док'), true, 'исключение внутри — уже не чистая ветка');
  assert.strictEqual(api.nodeCheckState('док'), 'partial');

  // Клик по «частичному» узлу стирает вложенные отметки и ставит свою — число
  // отметок при этом не меняется, так что на размер тут полагаться нельзя.
  api.toggleCheck(node('док'));
  assert.strictEqual(api.hasDescendantMark('док'), false);
  assert.strictEqual(api.nodeCheckState('док'), 'checked');

  api.onSelectAll({ target: { checked: true } });
  assert.strictEqual(api.hasDescendantMark('док'), false);

  api.toggleCheck(node('док/архив'));
  assert.strictEqual(api.hasDescendantMark('док'), true);

  // pruneMarks подменяет карту целиком — запомненный ответ обязан слететь и тут.
  api.state.roots = [node('фото')];
  api.pruneMarks({ localOk: true, networkOk: true });
  assert.strictEqual(api.hasDescendantMark('док'), false, 'папки больше нет — и отметок внутри нет');
});

// Список веток в предпросмотре строился по строке на каждую отмеченную ветку.
// «Выбрать все» на папке с 30 тысячами узлов давал 30 тысяч строк разметки одним
// innerHTML — то же, на чём когда-то вставало окно истории. Причём почти все они
// говорили «без изменений», то есть не сообщали ничего.
function previewOf(perFolder) {
  const { api } = fresh();
  api.renderPreview({
    perFolder,
    totals: { move: 0, copy: 1, overwrite: 0, trash: 0, unchanged: 0, dirs: 0, total: 1 },
    destTrashable: true,
  });
  return api.el.previewList.innerHTML;
}

const idleFolder = (name) => ({
  folder: name,
  summary: { move: 0, copy: 0, overwrite: 0, trash: 0, unchanged: 3, dirs: 0, total: 0 },
});
const busyFolder = (name) => ({
  folder: name,
  summary: { move: 0, copy: 2, overwrite: 0, trash: 0, unchanged: 0, dirs: 0, total: 2 },
});

test('короткий список веток показывается целиком, как и раньше', () => {
  const html = previewOf([busyFolder('док'), idleFolder('фото'), idleFolder('музыка')]);
  assert.match(html, /док/);
  assert.match(html, /фото/);
  assert.match(html, /музыка/);
  assert.match(html, /без изменений/);
});

test('на тысячах веток список сворачивается, а не строит строку на каждую', () => {
  const perFolder = [busyFolder('нужная'), busyFolder('тоже-нужная')];
  for (let i = 0; i < 5000; i += 1) perFolder.push(idleFolder(`пустая${i}`));

  const html = previewOf(perFolder);
  const rows = (html.match(/<li>/g) || []).length;

  assert.ok(rows < 600, `строк ${rows} — список не свернулся`);
  assert.match(html, /нужная/, 'ветки с работой показываются в первую очередь');
  assert.match(html, /тоже-нужная/);
  // Разряды в ru-RU разделяются неразрывным пробелом, поэтому сверяем нормализованно.
  assert.match(html.replace(/\s/g, ' '), /5 000 без изменений/, 'о свёрнутых сказано числом');
  assert.doesNotMatch(html, /пустая4999/);
});

test('размер строки находится при другом написании пути', () => {
  const { api } = fresh();
  const n = { relPath: 'Док', name: 'Док', isDir: true, hasLocal: true, hasNetwork: false };
  assert.strictEqual(api.metaFor(n, 'network').text, 'нет в сети');
  assert.strictEqual(api.metaFor(n, 'local').text, '');
  api.mergeSizes([{ relPath: 'док', sizeLocal: 2048, cntLocal: 3, sizeNetwork: null, cntNetwork: null }]);
  assert.match(api.metaFor(n, 'local').text, /3 файлов/);
});

test('шкала размеров не кончается раньше числа', () => {
  const { api } = fresh();
  assert.strictEqual(api.formatSize(0), '0 Б');
  assert.strictEqual(api.formatSize(null), '');
  assert.strictEqual(api.formatSize(1536), '1.5 КБ');
  assert.doesNotMatch(api.formatSize(2 ** 70), /undefined|NaN/);
});

test('имена и пути экранируются перед вставкой в разметку', () => {
  const { api } = fresh();
  assert.strictEqual(api.escapeHtml('<img src=x onerror="1">'), '&lt;img src=x onerror=&quot;1&quot;&gt;');
  assert.strictEqual(api.escapeHtml('&lt;'), '&amp;lt;');
});

test('папки всегда выше файлов, по дате — новые сверху', () => {
  const { api } = fresh();
  api.state.sort = 'name';
  const byName = api.sortNodes([
    { name: 'я', isDir: false, mtimeMs: 9 },
    { name: 'б', isDir: true, mtimeMs: 1 },
    { name: 'а', isDir: false, mtimeMs: 5 },
  ]).map((n) => n.name).slice();
  assert.deepStrictEqual(byName, ['б', 'а', 'я']);

  api.state.sort = 'date';
  const byDate = api.sortNodes([
    { name: 'старый', isDir: false, mtimeMs: 1 },
    { name: 'новый', isDir: false, mtimeMs: 99 },
  ]).map((n) => n.name).slice();
  assert.deepStrictEqual(byDate, ['новый', 'старый']);
});

// ---- Написание имени и опознание узла ----
// Имя папки берётся с той стороны, что попала в список первой. Пока локальная
// сторона недоступна, оно приходит с сетевой, а когда она возвращается — меняется
// регистр. Отметки это переживать научились раньше, узлы дерева — нет: раскрытая
// ветка схлопывалась, а загруженные дети выбрасывались, и так каждые шесть секунд.

// Поднимает renderer с заданным листингом и даёт стартовой инициализации доцлиться:
// init() читает настройки асинхронно, и правки состояния до её конца затирает refresh.
async function withListing(items) {
  const listing = { items, localOk: true, networkOk: true };
  const api = loadRenderer({
    getSettings: async () => ({}),
    saveSettings: async () => {},
    listFolders: async () => listing,
    probe: async () => ({ localOk: true, networkOk: true }),
    startCrawl: async () => {},
    stopCrawl: async () => {},
    onCrawl: () => () => {},
    onSyncProgress: () => () => {},
    onPreviewProgress: () => () => {},
  });
  await new Promise((r) => setTimeout(r, 0));
  api.state.localPath = 'C:\local';
  api.state.networkPath = '\\server\share';
  return api;
}

const asDto = (name) => ({ name, relPath: name, isDir: true, hasLocal: true, hasNetwork: true, mtimeMs: 0 });

test('смена написания не схлопывает раскрытую ветку и не теряет её детей', async () => {
  const api = await withListing([asDto('Док')]);

  // Ветка 'док' пришла с сетевой стороны, раскрыта, дети загружены.
  const корень = api.makeNode(asDto('док'));
  корень.loaded = true;
  корень.children = [api.makeNode({ ...asDto('внутри'), relPath: 'док/внутри' })];
  api.state.roots = [корень];
  api.state.expanded.add(api.expandKey('док'));

  // Локальная сторона вернулась — листинг отдаёт ту же папку как 'Док'.
  await api.lightRelistTop();

  assert.strictEqual(api.state.roots.length, 1);
  assert.strictEqual(api.state.roots[0], корень, 'узел тот же, а не созданный заново');
  assert.strictEqual(api.state.roots[0].name, 'Док', 'написание подтянулось за листингом');
  assert.strictEqual(api.state.roots[0].loaded, true, 'загруженность не потеряна');
  assert.strictEqual(api.state.roots[0].children.length, 1, 'дети на месте');
  assert.strictEqual(api.isExpanded('Док'), true, 'ветка осталась раскрытой');
});

test('смена написания перерисовывает строку, а не только модель', async () => {
  // Признак «список изменился» собирался из ключа без учёта регистра и пометок
  // присутствия, а подпись строки в него не входила. Написание в модели
  // обновлялось, перерисовки не было, и на экране оставалось прежнее имя.
  const api = await withListing([asDto('Док')]);
  api.state.roots = [api.makeNode(asDto('док'))];

  let renders = 0;
  const real = api.__ctx.renderTree;
  api.__ctx.renderTree = () => {
    renders += 1;
    return real();
  };

  await api.lightRelistTop();
  assert.strictEqual(api.state.roots[0].name, 'Док');
  assert.strictEqual(renders, 1, 'подпись строки изменилась — дерево обязано перерисоваться');

  // Второй тик ничего не меняет: лишних перерисовок каждые 6 секунд быть не должно.
  await api.lightRelistTop();
  assert.strictEqual(renders, 1);
});

test('отметка переживает смену написания вместе с узлом', async () => {
  const api = await withListing([asDto('Док')]);
  api.state.roots = [api.makeNode(asDto('док'))];
  api.toggleCheck(node('док'));

  await api.lightRelistTop();

  const { folders } = api.collectSelection();
  assert.deepStrictEqual(Array.from(folders), ['Док'], 'отметка осталась и переписалась под листинг');
});

// Предпросмотр — то место, где человек решает судьбу файлов, поэтому подпись
// и предупреждение проверяются на смысл, а не только на экранирование. Раньше
// и то и другое зависело от вида пути к приёмнику: сетевая папка, указанная
// буквой диска, обещала Корзину, которой на шаре нет.
function summaryOf(trash) {
  const { api } = fresh();
  api.renderPreview({
    perFolder: [{ folder: 'док', summary: { move: 0, copy: 1, overwrite: 0, trash, unchanged: 0, dirs: 0, total: 1 + trash } }],
    totals: { move: 0, copy: 1, overwrite: 0, trash, unchanged: 0, dirs: 0, total: 1 + trash },
  });
  return api.el.previewSummary.innerHTML;
}

test('предпросмотр обещает удаление, а не Корзину', () => {
  const html = summaryOf(3);
  assert.ok(!html.includes('в Корзину'), 'Корзины нет — обещать её нельзя');
  assert.ok(html.includes('удалить'), 'подпись у счётчика удалений');
  assert.ok(html.includes('безвозвратно'), 'предупреждение обязано быть до запуска, а не после');
});

test('без удалений предупреждение не показывается', () => {
  const html = summaryOf(0);
  assert.ok(!html.includes('безвозвратно'), 'пугать нечем: удалять нечего');
});

// Большие счётчики вылезали за плашки предпросмотра: плашка узкая (четыре в ряд
// в окне 900 px), шестизначное число шрифтом 21 px в неё не входит, а во время
// работы там ещё и «сделано/всего». Нашёл автор на своих папках.
test('большие счётчики печатаются с разрядами и мельче', () => {
  const { api } = fresh();
  api.renderPreview({
    perFolder: [{ folder: 'док', summary: { move: 0, copy: 1234567, overwrite: 98765, trash: 3, unchanged: 0, dirs: 0, total: 1333335 } }],
    totals: { move: 0, copy: 1234567, overwrite: 98765, trash: 3, unchanged: 0, dirs: 0, total: 1333335 },
  });
  const html = api.el.previewSummary.innerHTML;
  assert.ok(html.includes('1 234 567'), 'миллион с разрядами');
  assert.ok(!html.includes('1234567'), 'без разрядов длинное число не читается');
  assert.match(html, /class="num num-s"[^>]*>1 234 567/, 'длинное число - мельче');
  assert.match(html, /class="num "[^>]*>3</, 'короткое - обычным шрифтом');
});

test('во время работы «из N» отдельной строкой, а не через косую', () => {
  const { __ctx } = fresh().api;
  const html = __ctx.statNum(12345, 67890);
  assert.ok(html.includes('12 345') && html.includes('из 67 890'), html);
  assert.ok(!html.replace(/<[^>]+>/g, '').includes('/'), 'через косую строка выходила вдвое длиннее');
});

test('размер шрифта плашки растёт вниз вместе с длиной числа', () => {
  const { __ctx } = fresh().api;
  const order = ['', 'num-m', 'num-s', 'num-xs'];
  let prev = 0;
  for (const n of [0, 7, 42, 999, 1000, 99999, 100000, 9999999, 10000000, 1e9, 1e12]) {
    const cls = __ctx.numSize(__ctx.fmtNum(n));
    const rank = order.indexOf(cls);
    assert.ok(rank >= prev, `${n}: ${cls} крупнее, чем у числа поменьше`);
    prev = rank;
  }
  assert.strictEqual(prev, 3, 'у самых длинных - самый мелкий шрифт');
});
