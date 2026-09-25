'use strict';

// Общий замок двух версий (с 1.2.0): C#-версия не видит requestSingleInstanceLock
// Электрона, а делят они и служебную папку на приёмнике, и кеши. Замок - именованный
// канал: кто занял первым, тот и работает, вторая копия шлёт «show» и закрывается.
// Сторону C# против Node проверяет csharp/tests/.../InstanceLockTests.cs.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { loadMain } = require('./helpers/main-harness');

const unique = () => `SyncGlass-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Держит канал так, как его держит другая копия, и собирает то, что в него прислали.
function holdPipe(name) {
  return new Promise((resolve, reject) => {
    const got = [];
    const server = net.createServer((s) => s.on('data', (d) => got.push(String(d))));
    server.on('error', reject);
    server.listen(`\\\\.\\pipe\\${name}`, () => resolve({ server, got }));
  });
}

test('замок занят другой копией - окно не открывается, а первая зовётся показаться', async () => {
  const name = unique();
  const holder = await holdPipe(name);
  try {
    const { windows } = await loadMain({ pipe: name });
    assert.strictEqual(windows.length, 0, 'вторая копия не должна открывать окно');
    for (let i = 0; i < 100 && holder.got.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(holder.got, ['show']);
  } finally {
    holder.server.close();
  }
});

test('замок свободен - окно открывается, и канал занят этой копией', async () => {
  const name = unique();
  const { windows } = await loadMain({ pipe: name });
  assert.strictEqual(windows.length, 1);
  await assert.rejects(holdPipe(name), (e) => ['EADDRINUSE', 'EBUSY', 'EACCES'].includes(e.code));
});
