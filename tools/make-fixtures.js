'use strict';

// Образцы договора двух версий SyncGlass. Пишет их Node, читают тесты C#
// (csharp/tests/SyncGlass.Tests/ContractTests.cs): так сверяется то поведение,
// которое у JS-версии есть на деле, а не то, которое мы о ней помним.
// Образец - это договор: если C# с ним расходится, чинится C#, а не образец.
//
// Файлы состояния (настройки, история, кеш размеров) пишет сам main.js через
// тестовую обвязку - ровно теми обработчиками, которыми пишет живое приложение.
//
//   node tools/make-fixtures.js

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ciKey } = require('../src/paths');
const { loadMain, tmpDir, writeFile } = require('../test/helpers/main-harness');

const out = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(out, { recursive: true });

// Ключ путей. Обычные имена плюс буквы, у которых нижний регистр в разных
// системах считают по-разному: турецкая İ (в JS даёт две буквы), греческая
// сигма в конце слова, лигатуры, знаки Кельвина и Ома, буквы вне BMP.
const samples = [
  'Docs', 'ДОКУМЕНТЫ/Отчёт.TXT', 'Ёлка', 'a/B/c.D', 'straße',
  'İstanbul', 'MİX/İ', 'ΣΟΦΟΣ', 'ΟΔΟΣ/ΣΑ', 'ǅ', 'ǈ', 'ẞ', 'Ω', 'K', 'Å',
  'ﬀ', 'Ⅻ', 'Ⓐ', '𐐀', '𞤀', 'Ϊ́',
  // Конечная сигма: правило смотрит на соседние буквы, пропуская знаки без
  // регистра (ударения, апостроф, точка, двоеточие), и на границы пути.
  'Σ', 'ΑΣ', 'ΑΣΑ', '1Σ', 'ΑΣ1', 'ΑΣ.txt', 'ΑΣ/Β', 'Α/Σ', 'Α.Σ', "ΑΣ'Α", 'ΑΣ\u0301',
  'Α\u0301Σ', 'ΑΣ\u0301Α', 'ΑΣ:Α', 'ΑΣ·Α', 'ΑΣ Α', 'ΑΣ-Α', 'aΣ', 'ǅΣ', 'ΑΣ\u200DΑ',
];
fs.writeFileSync(
  path.join(out, 'cikey.json'),
  JSON.stringify(samples.map((s) => ({ s, key: ciKey(s) })), null, 2) + '\n'
);

// Генератор законов (test/invariants.test.js) - первые числа при засеве 7919:
// C# повторяет его до бита, чтобы случайные деревья в двух версиях совпадали.
{
  let seed = 7919;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  fs.writeFileSync(path.join(out, 'rnd.json'), JSON.stringify([rnd(), rnd(), rnd(), rnd(), rnd()]) + '\n');
}

(async () => {
  const { call, userData } = await loadMain();

  // Настройки - как их сохраняет окно.
  await call('save-settings', {
    localPath: 'C:\\Users\\Пример\\Документы',
    networkPath: '\\\\Сервер\\Общая папка',
    direction: 'toLocal',
    sort: 'date',
    sizeMode: 'capped',
  });
  await fsp.copyFile(path.join(userData, 'settings.json'), path.join(out, 'settings.json'));

  // История и кеш размеров - настоящим запуском и настоящим обходом.
  const local = await tmpDir();
  const network = await tmpDir();
  await writeFile(local, 'Отчёты/май.txt', 'новое');
  await writeFile(local, 'Отчёты/общий.txt', 'одинаково');
  await writeFile(network, 'Отчёты/общий.txt', 'одинаково');
  await writeFile(network, 'Отчёты/лишний.txt', 'убрать');
  await writeFile(network, 'Старое/узел', 'файл на месте папки');
  await writeFile(local, 'Старое/узел/внутри.txt', 'папка на источнике');
  const args = { localPath: local, networkPath: network, folders: ['Отчёты', 'Старое'], excludes: [], direction: 'toNetwork' };
  await call('sync', args);
  await fsp.copyFile(path.join(userData, 'history.json'), path.join(out, 'history.json'));

  await call('start-crawl', { localPath: local, networkPath: network });
  const cache = (await fsp.readdir(userData)).find((f) => f.startsWith('sizecache-'));
  await fsp.copyFile(path.join(userData, cache), path.join(out, 'sizecache.json'));
  fs.writeFileSync(
    path.join(out, 'sizecache-name.json'),
    JSON.stringify({ localPath: local, networkPath: network, file: cache }, null, 2) + '\n'
  );

  console.log('fixtures written:', out);
})();
