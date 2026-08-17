'use strict';

// Живая папка меняется под руками у обхода: временные файлы, кеш браузера,
// сборка. Файл, который readdir только что показал, к моменту stat уже может
// исчезнуть. Раньше такая гонка обрывала весь скан целиком — предпросмотр
// отвечал «не удалось прочитать папки», а синхронизация не начиналась вовсе,
// хотя пропал один-единственный временный файл.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { scanFiles, listChildren, crawlTree } = require('../src/fsops');

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'syncglass-race-'));

async function write(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

// Подменяет stat так, чтобы по одному конкретному пути он отвечал ошибкой.
// Гонку «файл исчез между readdir и stat» иначе не поймать: она зависит от того,
// кто успел первым, и в тесте не воспроизводится.
function breakStatFor(suffix, code) {
  const real = fsp.stat;
  fsp.stat = async (p, ...rest) => {
    if (String(p).endsWith(suffix)) {
      const err = new Error(code);
      err.code = code;
      throw err;
    }
    return real.call(fsp, p, ...rest);
  };
  return () => {
    fsp.stat = real;
  };
}

async function treeWithFive() {
  const root = await tmpDir();
  for (let i = 0; i < 5; i += 1) await write(root, `sub/f${i}.txt`, 'x');
  return root;
}

test('файл исчез между readdir и stat — скан продолжается без него', async (t) => {
  const root = await treeWithFive();
  const restore = breakStatFor('f2.txt', 'ENOENT');
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const skipped = [];
  const files = await scanFiles(root, '', [], null, null, null, [], skipped);

  assert.deepStrictEqual(
    files.map((f) => f.path).sort(),
    ['sub/f0.txt', 'sub/f1.txt', 'sub/f3.txt', 'sub/f4.txt']
  );
  // Файла действительно нет — это не «не дали посмотреть», а честное отсутствие.
  assert.deepStrictEqual(skipped, []);
});

test('файл исчез посреди подсчёта размеров — обход досчитывается', async (t) => {
  const root = await treeWithFive();
  const restore = breakStatFor('f2.txt', 'ENOENT');
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const seen = [];
  const total = await crawlTree(root, '', (rel, isDir) => {
    if (!isDir) seen.push(rel);
  }, null, []);

  assert.strictEqual(seen.length, 4);
  assert.strictEqual(total.count, 4);
});

test('прав на сам файл не дали — он выбывает из сравнения, а не рушит скан', async (t) => {
  const root = await treeWithFive();
  const restore = breakStatFor('f3.txt', 'EPERM');
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const skipped = [];
  const files = await scanFiles(root, '', [], null, null, null, [], skipped);

  assert.ok(!files.some((f) => f.path === 'sub/f3.txt'), 'размер файла неизвестен');
  // Молча выбросить его нельзя: пустое место на источнике по логике зеркала
  // означает «на приёмнике лишнее», и копия на приёмнике уехала бы в Корзину.
  assert.deepStrictEqual(skipped, ['sub/f3.txt']);
});

test('прав на файл не дали при подсчёте размеров — он тоже попадает в список', async (t) => {
  const root = await treeWithFive();
  const restore = breakStatFor('f3.txt', 'EACCES');
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const skipped = [];
  await crawlTree(root, '', () => {}, null, skipped);

  assert.deepStrictEqual(skipped, ['sub/f3.txt']);
});

test('прочие сбои stat по-прежнему обрывают обход', async (t) => {
  // Кончились дескрипторы, оборвалась сеть — принять это за «файла нет» значило бы
  // строить план по неполным данным и стереть с приёмника живую ветку.
  const root = await treeWithFive();
  const restore = breakStatFor('f1.txt', 'EMFILE');
  t.after(async () => {
    restore();
    await fsp.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => scanFiles(root, '', [], null, null, null, [], []),
    (err) => err.code === 'EMFILE'
  );
  await assert.rejects(
    () => crawlTree(root, '', () => {}, null, []),
    (err) => err.code === 'EMFILE'
  );
});

test('отмена предпросмотра пробивается сквозь новую обработку ошибок', async (t) => {
  // onFile бросает 'aborted', когда предпросмотр отменили. Ошибку файла мы теперь
  // глотаем, и отмена не должна утонуть вместе с ней.
  const root = await treeWithFive();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => scanFiles(root, '', [], null, () => { throw new Error('aborted'); }, null, [], []),
    /aborted/
  );
});

test('listChildren отличает пустую папку от нечитаемой', async (t) => {
  const root = await tmpDir();
  await fsp.mkdir(path.join(root, 'пусто'));
  await write(root, 'есть/a.txt', 'a');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const empty = await listChildren(path.join(root, 'пусто'));
  assert.deepStrictEqual(empty.items, []);
  assert.strictEqual(empty.ok, true, 'пустая папка прочитана успешно');

  const missing = await listChildren(path.join(root, 'нет-такой'));
  assert.deepStrictEqual(missing.items, []);
  assert.strictEqual(missing.ok, false, 'папки нет — список ничего не значит');

  const full = await listChildren(root);
  assert.strictEqual(full.ok, true);
  assert.deepStrictEqual(full.items.map((c) => c.name).sort(), ['есть', 'пусто']);
});
