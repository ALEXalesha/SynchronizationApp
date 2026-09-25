# SyncGlass на C#, этап 1: блокировка и чистое ядро — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** проверенная проба общей блокировки и перенесённые в C# `paths.js`, `sync.js`, `plan.js` (с нужной им частью `fsops.js`) вместе со всеми их тестами.

**Architecture:** решение `csharp/SyncGlass.sln`: `SyncGlass.Core` (net8.0, без WPF) и `SyncGlass.Tests` (xUnit). Модули переносятся один к одному: файл = модуль JS, метод = функция JS в PascalCase, комментарии «почему» переносятся. Источник истины для поведения — JS-код и JS-тесты; C#-тест — перевод JS-теста с тем же русским названием.

**Tech Stack:** .NET 8 (SDK 9.0.314 на ПК), xUnit 2.9.2, Node 24 для генерации образцов.

Проект: `docs/superpowers/specs/2026-09-26-syncglass-csharp-design.md`. Этапы 2–4 (FsOps целиком, Backend, окно, выпуск) — отдельными планами, когда дойдёт очередь.

---

## Правила переноса (читать до первой задачи)

Это места, где JS и C# расходятся молча. Каждое уже стоило бы бага.

| JS | C# | Почему |
|---|---|---|
| `a.sort()` без функции | `list.Sort(StringComparer.Ordinal)` | JS сортирует по кодам UTF-16, как `Ordinal` |
| `sort((a,b) => a.length - b.length)` | `OrderBy(x => x.Length)` (LINQ) | сортировка JS устойчивая, `List.Sort` — нет |
| `p.toLowerCase()` | `Paths.CiKey(p)` | сверяется образцом из Node (`fixtures/cikey.json`) |
| `Map`, `Set` | `Dictionary`, `HashSet` с `StringComparer.Ordinal` | ключи уже приведены через `CiKey`; порядок вставки `Dictionary` без удалений сохраняется, как у `Map` |
| `{...e, path: x}` | `e with { Path = x }` | записи неизменяемые |
| `mtimeMs` (дробное) | `double MtimeMs` | миллисекунды от 1970 с долями, как у Node |
| `path.join(root, rel)` | `Path.Join(root, rel)` | `rel` держим с `/`, Windows его понимает |
| `Promise.all` | `Task.WhenAll` | |
| `err.code === 'ENOENT'` | `FileNotFoundException`, `DirectoryNotFoundException` | |

Каждая задача заканчивается **мутацией**: вернуть в код ошибку, про которую тест, увидеть красный, вернуть назад. Без этого тест не засчитывается.

Команда тестов из корня репозитория: `dotnet test csharp/SyncGlass.sln`.

---

### Task 1: проба общей блокировки Node ↔ .NET

Решает, на чём строится `InstanceLock`: именованный канал или файл с PID.

**Files:**
- Create (scratchpad, не в репо): `pipe_node.js`, `PipeProbe/Program.cs`, `PipeProbe/PipeProbe.csproj`

- [ ] **Step 1: Node держит канал**

```js
// pipe_node.js — держит канал, пока не убьют
const net = require('net');
const name = '\\\\.\\pipe\\SyncGlass-probe';
const srv = net.createServer((s) => { s.on('data', (d) => console.log('got', d.toString())); });
srv.on('error', (e) => { console.log('node listen error', e.code); process.exit(2); });
srv.listen(name, () => console.log('node holds pipe'));
```

- [ ] **Step 2: .NET пытается занять тот же канал**

```csharp
using System.IO.Pipes;
var name = "SyncGlass-probe";
try {
    using var s = new NamedPipeServerStream(name, PipeDirection.In, 1);
    Console.WriteLine("dotnet holds pipe");
    Console.ReadLine();
} catch (IOException e) { Console.WriteLine("dotnet refused: " + e.Message); }
```

- [ ] **Step 3: четыре прогона**
  1. Node держит → .NET: ожидается `dotnet refused`.
  2. .NET держит → Node: ожидается `node listen error EADDRINUSE`.
  3. Node держит → второй Node: ожидается `EADDRINUSE`.
  4. Убить держателя → второй занимает сразу (канал освобождён без уборки).

Плюс: .NET-клиент (`NamedPipeClientStream`) шлёт «show» в канал Node и наоборот.

- [ ] **Step 4: записать итог в проект** — раздел «Общая блокировка» в спецификации: что вышло, и какой механизм выбран. Если хоть один прогон не как ожидалось — механизм «файл `instance.lock` с PID и временем старта».

---

### Task 2: каркас решения

**Files:**
- Create: `csharp/SyncGlass.sln`, `csharp/src/SyncGlass.Core/SyncGlass.Core.csproj`, `csharp/tests/SyncGlass.Tests/SyncGlass.Tests.csproj`, `csharp/.gitignore`

- [ ] **Step 1: проекты**

```bash
cd csharp
dotnet new sln -n SyncGlass
dotnet new classlib -n SyncGlass.Core -o src/SyncGlass.Core -f net8.0
dotnet new xunit -n SyncGlass.Tests -o tests/SyncGlass.Tests -f net8.0
dotnet sln add src/SyncGlass.Core tests/SyncGlass.Tests
dotnet add tests/SyncGlass.Tests reference src/SyncGlass.Core
```

Удалить `Class1.cs` и `UnitTest1.cs`. В обоих csproj: `<Nullable>enable</Nullable>`, `<ImplicitUsings>enable</ImplicitUsings>`, `<RootNamespace>SyncGlass.Core</RootNamespace>` / `SyncGlass.Tests`. Версии пакетов тестов — как в Paint: `Microsoft.NET.Test.Sdk 17.11.1`, `xunit 2.9.2`, `xunit.runner.visualstudio 2.8.2`. `InternalsVisibleTo("SyncGlass.Tests")` в Core — тесты зовут внутренние функции так же, как JS-тесты зовут неэкспортированные через модуль.

`csharp/.gitignore`: `bin/`, `obj/`, `*.user`.

- [ ] **Step 2:** `dotnet build csharp/SyncGlass.sln` → `Build succeeded`.
- [ ] **Step 3: коммит** «C#-версия: каркас решения».

---

### Task 3: образцы из Node и `Paths`

**Files:**
- Create: `tools/make-fixtures.js`, `fixtures/cikey.json`, `csharp/src/SyncGlass.Core/Paths.cs`, `csharp/tests/SyncGlass.Tests/PathsTests.cs`, `csharp/tests/SyncGlass.Tests/ContractTests.cs`, `csharp/tests/SyncGlass.Tests/Fixtures.cs`

- [ ] **Step 1: генератор образцов**

```js
// tools/make-fixtures.js — образцы договора двух версий. Пишет их Node,
// читают тесты C#: так сверяется ровно то поведение, которое у JS на деле.
'use strict';
const fs = require('fs');
const path = require('path');
const { ciKey } = require('../src/paths');
const out = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(out, { recursive: true });
const samples = [
  'Docs', 'ДОКУМЕНТЫ/Отчёт.TXT', 'Ёлка', 'İstanbul', 'ΣΟΦΟΣ', 'ǅ', 'ẞ', 'Ω', 'K',
  'ﬀ', 'Ⅻ', 'Ⓐ', '𐐀', 'straße', 'MİX/İ', 'a/B/c.D',
];
fs.writeFileSync(path.join(out, 'cikey.json'),
  JSON.stringify(samples.map((s) => ({ s, key: ciKey(s) })), null, 2) + '\n');
console.log('fixtures written');
```

Run: `node tools/make-fixtures.js` → `fixtures written`.

- [ ] **Step 2: красные тесты**

`Fixtures.cs` — путь к `fixtures/` от папки сборки вверх до `.git`:

```csharp
namespace SyncGlass.Tests;

internal static class Fixtures
{
    public static string Dir { get; } = Find();

    private static string Find()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "fixtures")) && Directory.Exists(Path.Combine(d.FullName, "csharp")))
                return Path.Combine(d.FullName, "fixtures");
        throw new DirectoryNotFoundException("fixtures/ не найдена выше " + AppContext.BaseDirectory);
    }

    public static string Read(string name) => File.ReadAllText(Path.Combine(Dir, name));
}
```

`ContractTests.cs`:

```csharp
using System.Text.Json;
using SyncGlass.Core;

namespace SyncGlass.Tests;

public class ContractTests
{
    private sealed record CiSample(string s, string key);

    // Ключ сравнения путей обязан совпадать с JS до символа: по нему обе версии
    // решают, один это файл или два, и по нему же называется файл кеша размеров.
    [Fact]
    public void CiKey_совпадает_с_toLowerCase_из_Node()
    {
        var samples = JsonSerializer.Deserialize<CiSample[]>(Fixtures.Read("cikey.json"))!;
        Assert.NotEmpty(samples);
        foreach (var x in samples) Assert.Equal(x.key, Paths.CiKey(x.s));
    }
}
```

`PathsTests.cs` — перевод трёх тестов `test/paths.test.js` (`path.resolve('data')` → `Path.GetFullPath("data")`, `path.sep` → `Path.DirectorySeparatorChar`), названия те же:
`rootsOverlap_ловит_вложенность_корней_в_обе_стороны`, `rootsOverlap_считает_одну_и_ту_же_папку_пересечением`, `rootsOverlap_пропускает_соседние_папки_и_общий_префикс_имени`.

Run: `dotnet test csharp/SyncGlass.sln` → ошибка сборки: `Paths` не существует.

- [ ] **Step 3: `Paths.cs`**

```csharp
namespace SyncGlass.Core;

/// <summary>Перенос src/paths.js.</summary>
public static class Paths
{
    // Ключ для сравнения путей двух сторон. Регистр не значим: NTFS и сетевые шары
    // не различают 'Docs' и 'docs' (подробно - src/paths.js). Инвариантный регистр,
    // а не текущий язык: локаль пользователя не должна влиять на то, совпали пути
    // или нет. Совпадение с JS до символа держит ContractTests по образцу из Node.
    public static string CiKey(string p) => p.ToLowerInvariant();

    // Лежит ли inner внутри outer (или это тот же путь).
    public static bool IsInside(string inner, string outer)
    {
        var a = Path.GetFullPath(inner).ToLowerInvariant();
        var b = Path.GetFullPath(outer).ToLowerInvariant();
        var sep = Path.DirectorySeparatorChar.ToString();
        return a == b || a.StartsWith(b.EndsWith(sep) ? b : b + sep, StringComparison.Ordinal);
    }

    // Пересекаются ли корни синхронизации: один внутри другого или это одна папка.
    public static bool RootsOverlap(string srcRoot, string dstRoot)
        => IsInside(srcRoot, dstRoot) || IsInside(dstRoot, srcRoot);
}
```

Внимание: `path.resolve` в Node срезает хвостовой разделитель, `GetFullPath` — нет. Тест «`base + sep`» это и ловит; если красный — срезать `TrimEnd` хвост, кроме корня диска (`C:\`).

- [ ] **Step 4:** тесты зелёные. Если `CiKey_совпадает` красный на отдельных образцах (ожидаемые кандидаты — `İ`, `ẞ`, `ǅ`), дописать в `CiKey` точечные замены по образцу JS и комментарий, какой символ и почему. Регенерировать образец нельзя — он и есть договор.
- [ ] **Step 5: мутация:** `CiKey` → `p.ToLower()` при `CultureInfo("tr-TR")` в тесте даёт красный на `İ`; `IsInside` без добавления разделителя → красный на `data2`.
- [ ] **Step 6: коммит** «C#: Paths и образец ключа путей из Node».

---

### Task 4: `Sync`

**Files:**
- Create: `csharp/src/SyncGlass.Core/Model.cs`, `csharp/src/SyncGlass.Core/Sync.cs`, `csharp/tests/SyncGlass.Tests/SyncTests.cs`

- [ ] **Step 1: модель** (общая для Sync, Plan и дальше):

```csharp
namespace SyncGlass.Core;

// Запись файла: путь относительно корня выбранной папки, разделитель '/'.
public sealed record FileEntry(string Path, long Size, double MtimeMs);

// Кандидат в перемещение и подтверждённое перемещение (см. Sync.PairUp).
public sealed record Move(string From, string To, string Path, long Size, FileEntry Gone, FileEntry Added);

public sealed class DirPlan
{
    public List<string> Create { get; init; } = new();
    public List<string> Remove { get; init; } = new();
}

// План запуска. Изменяемый, как в JS: confirmMoves и сборка плана дописывают его по месту.
public sealed class SyncPlan
{
    public List<FileEntry> Copy { get; set; } = new();
    public List<FileEntry> Overwrite { get; set; } = new();
    public List<FileEntry> Trash { get; set; } = new();
    public List<FileEntry> Unchanged { get; set; } = new();
    public List<Move> Moves { get; set; } = new();
    public DirPlan Dirs { get; set; } = new();
    public List<string> Conflicts { get; set; } = new();
    public List<string> Skipped { get; set; } = new();
}

public sealed record Summary(int Move, int Copy, int Overwrite, int Trash, int Unchanged, int Dirs, int Total);
```

- [ ] **Step 2: красные тесты** — перевод всех тестов `test/sync.test.js` (177 строк), названия те же, помощник `F(path, size, mtime)`. `assert.deepStrictEqual(plan.copy.map(e => e.path), [...])` → `Assert.Equal(new[]{...}, plan.Copy.Select(e => e.Path))`.

Run → сборка падает: нет `Sync`.

- [ ] **Step 3: `Sync.cs`** — перенос `src/sync.js` функция в функцию: `MtimeToleranceMs = 2000`, `IndexByPath`, `IsChanged`, `PlanSync`, `BaseName`, `KeyByName`, `GroupBy` (Dictionary с порядком вставки), `PairUp`, `DetectMoves` (возвращает новый `SyncPlan` с теми же Dirs/Conflicts/Skipped и новыми Moves/Copy/Trash), `UniqueDirs`, `PlanDirs` (сортировка `StringComparer.Ordinal`, `Remove` — обратный порядок), `Summarize`. Комментарии «почему» из JS переносятся сокращённо, со ссылкой на `src/sync.js`.

- [ ] **Step 4:** зелёные.
- [ ] **Step 5: мутации:** `IsChanged` с `>=` вместо `>` (граница 2000 мс); `PairUp` без проверки `from.length !== 1`; `PlanDirs` без `CiKey`. Каждая — красный тест.
- [ ] **Step 6: коммит** «C#: Sync».

---

### Task 5: часть `FsOps`, нужная плану — `RunPool` и `SameContent`

**Files:**
- Create: `csharp/src/SyncGlass.Core/FsOps.cs`, `csharp/tests/SyncGlass.Tests/FsOpsTests.cs`, `csharp/tests/SyncGlass.Tests/TempDir.cs`

- [ ] **Step 1: `TempDir`** — временная папка на тест, убирается в `Dispose` (в Корзину не нужно: это папка теста в `%TEMP%`, как `fs.mkdtemp` в JS-тестах).

```csharp
namespace SyncGlass.Tests;

internal sealed class TempDir : IDisposable
{
    public string Root { get; } = Directory.CreateTempSubdirectory("sgtest-").FullName;
    public string P(string rel) => Path.Join(Root, rel);
    public void Write(string rel, string text, DateTime? mtimeUtc = null)
    {
        var p = P(rel);
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        File.WriteAllText(p, text);
        if (mtimeUtc is { } t) File.SetLastWriteTimeUtc(p, t);
    }
    public void Dispose() { try { Directory.Delete(Root, true); } catch { } }
}
```

- [ ] **Step 2: красные тесты** — перевод тестов `sameContent` и `runPool` из `test/fsops.test.js` (найти: `grep -n "sameContent\|runPool" test/fsops.test.js`) плюс:
  - `RunPool` не держит в работе больше `concurrency` задач (счётчик в воздухе);
  - `SameContent` различает файлы одного размера с разницей в середине большого файла только если разница попала в края — как в JS: читаются края по 64 КБ (`SAMPLE_BYTES`), это осознанное решение, тест его фиксирует.

- [ ] **Step 3: код**

```csharp
namespace SyncGlass.Core;

/// <summary>Перенос src/fsops.js. На этом этапе - только то, что нужно плану.</summary>
public static partial class FsOps
{
    public const int ScanConcurrency = 32;
    public const int ApplyConcurrency = 16;
    public const string StageDir = ".sgundo";
    private const int SampleBytes = 65536;

    // Пул работников над списком: не больше concurrency задач разом.
    public static async Task RunPool<T>(IReadOnlyList<T> items, int concurrency, Func<T, Task> worker)
    {
        var next = -1;
        var n = Math.Min(concurrency, items.Count);
        var runners = new Task[n];
        for (var c = 0; c < n; c++)
            runners[c] = Task.Run(async () =>
            {
                int idx;
                while ((idx = Interlocked.Increment(ref next)) < items.Count) await worker(items[idx]);
            });
        await Task.WhenAll(runners);
    }

    // Края файла: начало и конец по SampleBytes (весь файл, если он меньше двух краёв).
    private static async Task<byte[]> Edges(string file, long size)
    {
        await using var fh = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1, true);
        if (size <= 2L * SampleBytes)
        {
            var all = new byte[size];
            await fh.ReadExactlyAsync(all);
            return all;
        }
        var buf = new byte[2 * SampleBytes];
        await fh.ReadExactlyAsync(buf.AsMemory(0, SampleBytes));
        fh.Position = size - SampleBytes;
        await fh.ReadExactlyAsync(buf.AsMemory(SampleBytes, SampleBytes));
        return buf;
    }

    public static async Task<bool> SameContent(string a, string b)
    {
        var fa = new FileInfo(a);
        var fb = new FileInfo(b);
        if (!fa.Exists || !fb.Exists || fa.Length != fb.Length) return false;
        if (fa.Length == 0) return true;
        var ea = Edges(a, fa.Length);
        var eb = Edges(b, fb.Length);
        return (await ea).AsSpan().SequenceEqual(await eb);
    }
}
```

Перед записью `Edges` свериться с JS `edges()` (строки 346–360 `src/fsops.js`): порог «весь файл» и позиции краёв должны совпасть с JS буква в букву; код выше поправить под JS, если отличается.

- [ ] **Step 4:** зелёные. **Step 5: мутации:** `RunPool` с `concurrency + 1` → красный счётчик; `SameContent` без сравнения длины → красный.
- [ ] **Step 6: коммит** «C#: RunPool и SameContent».

---

### Task 6: `Plan`, чистые функции

**Files:**
- Create: `csharp/src/SyncGlass.Core/Plan.cs`, `csharp/tests/SyncGlass.Tests/PlanTests.cs`

- [ ] **Step 1: типы сканов**

```csharp
namespace SyncGlass.Core;

// Результат скана ветки: пути относительно ветки.
public sealed record ScanResult(List<FileEntry> Files, List<string> Dirs, List<string> Skipped)
{
    public static ScanResult Empty() => new(new(), new(), new());
}

// Индекс завершённого обхода одной стороны: пути от корня стороны.
public sealed record CrawlSide(Dictionary<string, (long Size, double MtimeMs)> Files, HashSet<string> Dirs, List<string> Skipped);

// Сканер ветки: (корень, ветка, исключения) → скан. В main.js его собирает makeScanner.
public delegate Task<ScanResult> Scanner(string root, string branch, IReadOnlyCollection<string> excludes);

public sealed record FolderCount(string Folder, Summary Summary);
```

- [ ] **Step 2: красные тесты** — из `test/plan.test.js` все тесты функций, которым не нужен диск: `ancestorsOf`, `scanFromIndex`, `groupIndexByBranch`, `groupExcludesByBranch`, `countByFolder`, плюс `topPaths`/`underAny` через них. Найти: `grep -nE "^test\(" test/plan.test.js` и переводить по порядку, названия те же.

- [ ] **Step 3: код** — перенос из `src/plan.js`: `AncestorsOf`, `AppendAll` (не нужен — `List.AddRange`), `CoveredByKey`, `UnderAny` (возвращает `Func<string,bool>`), `TopPaths` (устойчивая сортировка `OrderBy(Length)`), `FindTypeConflicts`, `ScanFromIndex`, `GroupIndexByBranch`, `GroupExcludesByBranch` (`Dictionary<string, HashSet<string>>`), `CountByFolder` (ветки «от длинных к коротким» — `OrderByDescending(Length)`, устойчиво).

- [ ] **Step 4:** зелёные. **Step 5: мутации:** `TopPaths` через `List.Sort` (неустойчивая) — если ни один тест не краснеет, это не ошибка мутации, а дыра: дописать тест на порядок равных по длине; `CountByFolder` берёт первую, а не самую длинную ветку → красный.
- [ ] **Step 6: коммит** «C#: Plan, чистые функции».

---

### Task 7: `Plan`, работа с диском

> **Изменение порядка (26.09):** код `Plan` написан целиком в задаче 6, но почти
> все JS-тесты плана с диском зовут `scanFiles` (живой сканер), `applyPlan`
> и `crawlTree`. Поэтому их перенос (`PlanDiskTests`) идёт после переноса
> `FsOps` целиком (этап 2), а мутации `TopPaths` и `ConfirmMoves` повторяются
> тогда же: в чистых тестах их ловить нечем.

**Files:**
- Modify: `csharp/src/SyncGlass.Core/Plan.cs`, `csharp/tests/SyncGlass.Tests/PlanTests.cs`

- [ ] **Step 1: красные тесты** — остальные тесты `test/plan.test.js`: `planForBranch`, `buildRunPlan`, `statType` (типы веток, конфликты «папка против файла», закрытые правами узлы через подставной сканер, подтверждение перемещений по содержимому, счёт обращений к диску через памятку). Сканер в тестах — живой рекурсивный обход `TempDir`, написанный в самом тесте, как в JS-тестах (найти: `grep -n "scan =" test/plan.test.js`).

- [ ] **Step 2: код** — `StatType(root, rel, memo)` с памяткой `ConcurrentDictionary<string, Task<NodeType>>` (ключ `root + "\0" + CiKey(rel)`), `ReadType`, `StatEntry`, `TypesOf`, `PrefetchTypes` (через `FsOps.RunPool`), `PlanForBranch`, `ConfirmMoves`, `BuildRunPlan`. `NodeType` — `enum { Dir, File, Missing }`. `ENOTDIR` в .NET приходит как `DirectoryNotFoundException` или `IOException` — трактовать как `Missing` так же, как JS.

- [ ] **Step 3:** зелёные, весь набор: `dotnet test csharp/SyncGlass.sln`.
- [ ] **Step 4: мутации:** `PlanForBranch` сканирует сторону-файл (убрать проверку `srcType == Dir`) → красный; `ConfirmMoves` признаёт всё (`verdict = true`) → красный на «чужом содержимом»; без памятки в `StatType` → красный тест счёта обращений.
- [ ] **Step 5: коммит** «C#: Plan целиком — план запуска как у Electron».

---

### Task 8: CI и отправка

**Files:**
- Modify: `.github/workflows/ci.yml`, `.gitea/workflows/ci.yml`

- [ ] **Step 1:** в GitHub — шаг `actions/setup-dotnet@v4` с `dotnet-version: 8.0.x` и шаг `dotnet test csharp/SyncGlass.sln`; в Gitea — только `dotnet test csharp/SyncGlass.sln` (без setup-dotnet: у раннера ПК нет прав на Program Files, .NET уже стоит). Шапки файлов дополнить строкой о C#-проверках.
- [ ] **Step 2:** `npm test` и `dotnet test` локально зелёные.
- [ ] **Step 3: коммит, `git push origin main` (Gitea)**, дождаться зелёного прогона на Gitea. На GitHub этап 1 не публикуется: выпуск общий, 1.2.0, в конце всех этапов.
