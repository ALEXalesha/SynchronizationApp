'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { buildRunPlan } = require('../src/plan');
const { scanFiles, applyPlan, restoreStage, STAGE_DIR } = require('../src/fsops');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-stress-'));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

const liveScan = async (root, branch) => {
  const dirs = [];
  const files = await scanFiles(path.join(root, branch), '', [], null, null, null, dirs);
  return { files, dirs };
};

const mockTrash = async (abs) => fsp.rm(abs, { recursive: true, force: true });

// Снимок дерева: путь → содержимое (для папок — null). Так видно и структуру,
// и данные, а сравнение двух снимков заменяет десяток отдельных проверок.
async function snapshot(dir, rel = '', out = new Map()) {
  let dirents;
  try {
    dirents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.set(`${r}/`, null);
      await snapshot(dir, r, out);
    } else {
      out.set(r, await fsp.readFile(path.join(dir, r), 'utf8'));
    }
  }
  return out;
}

function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return false;
  return true;
}

// Детерминированный генератор: тесты должны падать одинаково, а не через раз.
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

async function buildTree(root, rnd) {
  const folders = ['Док', 'Док/2025', 'Фото', 'Фото/лето', 'Архив'];
  for (const f of folders) await fsp.mkdir(path.join(root, f), { recursive: true });
  const made = [];
  for (let i = 0; i < 30; i += 1) {
    const folder = folders[Math.floor(rnd() * folders.length)];
    const rel = `${folder}/файл${i}.txt`;
    await writeFile(root, rel, `содержимое ${i} ${'z'.repeat(Math.floor(rnd() * 50))}`);
    made.push(rel);
  }
  return { folders, files: made };
}

test('случайные изменения: после синхронизации деревья совпадают, повтор пуст', async () => {
  for (let seed = 1; seed <= 6; seed += 1) {
    const rnd = makeRandom(seed * 7919);
    const src = await tmpDir();
    const dst = await tmpDir();

    const { folders, files } = await buildTree(src, rnd);
    await fsp.cp(src, dst, { recursive: true });

    // Перекладываем, переименовываем, меняем и удаляем — вперемешку.
    for (const rel of files) {
      const roll = rnd();
      if (roll < 0.25) {
        const to = `${folders[Math.floor(rnd() * folders.length)]}/${path.basename(rel)}`;
        if (to !== rel && !fs.existsSync(path.join(src, to))) {
          await fsp.rename(path.join(src, rel), path.join(src, to));
        }
      } else if (roll < 0.4) {
        await fsp.writeFile(path.join(src, rel), `изменено ${rnd()}`);
        // Правку двигаем по времени вперёд: сравнение дат идёт с допуском в 2 с,
        // а тест пишет все файлы в одно мгновение.
        const later = new Date(Date.now() + 3600_000);
        await fsp.utimes(path.join(src, rel), later, later);
      } else if (roll < 0.5) {
        await fsp.rm(path.join(src, rel));
      }
    }
    await fsp.mkdir(path.join(src, 'СовсемНовая/Вложенная'), { recursive: true });
    await writeFile(src, 'СовсемНовая/новьё.txt', 'свежак');
    await fsp.mkdir(path.join(dst, 'Лишняя/Глубже'), { recursive: true });

    const roots = ['Док', 'Фото', 'Архив', 'СовсемНовая', 'Лишняя'];
    const plan = await buildRunPlan(src, dst, roots, [], liveScan);
    const res = await applyPlan(src, dst, plan, mockTrash);

    assert.strictEqual(res.failures.length, 0, `seed ${seed}: ошибки ${JSON.stringify(res.failures)}`);
    assert.ok(
      sameSnapshot(await snapshot(src), await snapshot(dst)),
      `seed ${seed}: деревья разошлись`
    );

    const again = await buildRunPlan(src, dst, roots, [], liveScan);
    const left =
      again.moves.length + again.copy.length + again.overwrite.length + again.trash.length +
      again.dirs.create.length + again.dirs.remove.length;
    assert.strictEqual(left, 0, `seed ${seed}: повторный проход нашёл ${left} действий`);
  }
});

test('остановка в любой точке возвращает приёмник ровно в исходное состояние', async () => {
  // Каждая итерация останавливает работу на N-м действии. Проходим весь диапазон,
  // чтобы обрыв попал и в копирование, и в перезапись, и в удаление, и в папки.
  for (const stopAt of [1, 3, 7, 12, 20, 35, 60]) {
    const rnd = makeRandom(stopAt * 104729);
    const src = await tmpDir();
    const dst = await tmpDir();

    await buildTree(src, rnd);
    await fsp.cp(src, dst, { recursive: true });
    await writeFile(src, 'Док/новый.txt', 'новый файл');
    await fsp.writeFile(path.join(src, 'Док/файл0.txt'), 'перезаписанное содержимое');
    await fsp.rename(path.join(src, 'Архив'), path.join(src, 'Архив2'));
    await writeFile(dst, 'Лишний/мусор.txt', 'выкинуть');
    await fsp.mkdir(path.join(src, 'ПустаяНовая'), { recursive: true });

    const before = await snapshot(dst);
    const roots = ['Док', 'Фото', 'Архив', 'Архив2', 'Лишний', 'ПустаяНовая'];
    const plan = await buildRunPlan(src, dst, roots, [], liveScan);

    let steps = 0;
    const res = await applyPlan(src, dst, plan, mockTrash, () => {
      steps += 1;
    }, { shouldStop: () => steps >= stopAt });

    if (!res.cancelled) continue; // работы оказалось меньше, чем точка останова
    const after = await snapshot(dst);
    assert.ok(
      sameSnapshot(before, after),
      `stopAt ${stopAt}: приёмник не вернулся в исходное состояние`
    );
    assert.strictEqual(fs.existsSync(path.join(dst, STAGE_DIR)), false, `stopAt ${stopAt}: осталась служебная папка`);
  }
});

test('оборванный запуск в обратную сторону: оригиналы не считаются пропавшими', async () => {
  const a = await tmpDir();
  const b = await tmpDir();
  await writeFile(a, 'Док/важное.txt', 'ценные данные');
  await writeFile(b, 'Док/важное.txt', 'ценные данные');

  // Имитируем вылет посреди синхронизации A → B: оригинал уехал в служебную папку B.
  await fsp.mkdir(path.join(b, `${STAGE_DIR}/Док`), { recursive: true });
  await fsp.rename(path.join(b, 'Док/важное.txt'), path.join(b, `${STAGE_DIR}/Док/важное.txt`));

  // Теперь синхронизируем B → A. Без разбора служебной папки файл выглядел бы
  // удалённым на источнике, и синхронизация стёрла бы его и в A.
  for (const root of [b, a]) await restoreStage(root);

  const plan = await buildRunPlan(b, a, ['Док'], [], liveScan);
  assert.strictEqual(plan.trash.length, 0);
  await applyPlan(b, a, plan, mockTrash);
  assert.strictEqual(await fsp.readFile(path.join(a, 'Док/важное.txt'), 'utf8'), 'ценные данные');
});

test('файл нельзя отложить — удаление идёт напрямую, синхронизация не встаёт', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await writeFile(src, 'остаётся.txt', 'ок');
  await writeFile(dst, 'остаётся.txt', 'ок');
  await writeFile(dst, 'лишний.txt', 'выкинуть');

  const plan = await buildRunPlan(src, dst, ['остаётся.txt', 'лишний.txt'], [], liveScan);
  // Занимаем имя служебной папки файлом: mkdir внутрь него не пройдёт.
  await fsp.writeFile(path.join(dst, STAGE_DIR), 'занято');

  const trashed = [];
  const res = await applyPlan(src, dst, plan, async (abs) => {
    trashed.push(path.basename(abs));
    await fsp.rm(abs, { recursive: true, force: true });
  });

  assert.strictEqual(res.failures.length, 0);
  assert.strictEqual(res.unrecoverable, 1);
  assert.deepStrictEqual(trashed, ['лишний.txt']);
  assert.strictEqual(fs.existsSync(path.join(dst, 'лишний.txt')), false);
});

// Ветка с сотнями тысяч файлов. Слияние планов по веткам не должно упираться
// в предел числа аргументов вызова: push(...arr) ломается примерно на 125k.
test('масштаб: ветка на 200k файлов сливается в общий план', async () => {
  const src = await tmpDir();
  const dst = await tmpDir();
  await fsp.mkdir(path.join(src, 'big'));
  await fsp.mkdir(path.join(dst, 'big'));

  const N = 200000;
  const files = [];
  const dirs = [];
  for (let i = 0; i < N; i += 1) {
    files.push({ path: `f${i}.bin`, size: 10, mtimeMs: 1000 });
    dirs.push(`d${i}`);
  }
  const hugeScan = async () => ({ files, dirs });

  const plan = await buildRunPlan(src, dst, ['big'], [], hugeScan);
  assert.strictEqual(plan.unchanged.length, N);
  assert.strictEqual(plan.copy.length, 0);
  assert.strictEqual(plan.trash.length, 0);
  assert.strictEqual(plan.dirs.create.length, 0);
  assert.strictEqual(plan.dirs.remove.length, 0);
});
