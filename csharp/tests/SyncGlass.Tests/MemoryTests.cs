using SyncGlass.Core;

namespace SyncGlass.Tests;

// Перенос test/memory.test.js - закон памяти обхода: сколько работы одновременно
// в руках, не зависит от размера дерева.
//
// В JS закон считал промисы, ждущие разом: обход ставил задачу на каждый файл,
// и на дереве в 300 тысяч узлов процесс раздувался до 700 МБ. В C# файлы учитываются
// прямо из списка папки, задачи на файл нет по устройству, - поэтому закон спрашивает
// то, что осталось изменяемым: сколько чтений папок идёт разом (не больше работников
// и не растёт с деревом), плюс что обход работниками отвечает ровно как простой.
//
// ЧЕГО ЭТОТ ЗАКОН НЕ СПРАШИВАЕТ: лёгкие записи папок на стеке работников растут
// с шириной дерева - это путь и ссылка на родителя, путь хранится всё равно.
public class MemoryTests
{
    // По десять папок на уровень, по три файла в каждой.
    private static TempDir Ветвистое(int папок)
    {
        var t = new TempDir();
        for (var i = 0; i < папок; i++)
        {
            var dir = $"a{i % 10}/b{i / 10 % 10}/c{i}";
            for (var k = 0; k < 3; k++) t.Write($"{dir}/f{k}.txt", "xy");
        }
        return t;
    }

    // Наибольшее число чтений папок разом за время action. Каждое чтение чуть ждёт,
    // иначе на быстром диске перекрытия не видно вовсе.
    private static async Task<int> ПикЧтений(Func<Task> action)
    {
        var вРуках = 0;
        var пик = 0;
        var gate = new object();
        FsOps.ReadDirFault.Value = _ =>
        {
            var now = Interlocked.Increment(ref вРуках);
            lock (gate) if (now > пик) пик = now;
            Thread.Sleep(2);
            Interlocked.Decrement(ref вРуках);
            return null;
        };
        try
        {
            await action();
        }
        finally
        {
            FsOps.ReadDirFault.Value = null;
        }
        return пик;
    }

    public static IEnumerable<object[]> Дороги() => [["обход для размеров"], ["скан для плана"]];

    private static Task Пройти(string дорога, string root) => дорога == "обход для размеров"
        ? FsOps.CrawlTree(root, "", (_, _, _, _, _) => { }, [])
        : FsOps.ScanFiles(root, "", null, null, () => { }, [], []);

    // Чтений папок разом не больше работников, как бы ни росло дерево. Честно о границе
    // закона: чтение папки синхронное, и потоков пул даёт примерно по числу ядер, так
    // что «работников вчетверо больше» этот тест не отличит (мутацией проверено - не
    // ловит), а нижний порог перекрытия под нагрузкой соседних тестов плавает. Память
    // в C# держит само устройство обхода - задачи на файл нет, - а тест сторожит
    // верхнюю границу и то, что ответы обхода верны (два теста ниже).
    [Theory]
    [MemberData(nameof(Дороги))]
    public async Task память_обхода_папок_x4_чтений_разом_не_больше_работников(string дорога)
    {
        using var большое = Ветвистое(400);
        var b = await ПикЧтений(() => Пройти(дорога, большое.Root));
        Assert.True(b <= FsOps.ScanConcurrency, $"{дорога}: {b} чтений разом при {FsOps.ScanConcurrency} работниках");
    }

    // Тот же обход должен дать те же ответы, что и простой: сумма, число, порядок
    // «папка после своего содержимого», все файлы ровно по разу.
    [Fact]
    public async Task обход_работниками_папка_отчитывается_после_всего_своего_содержимого_итоги_верны()
    {
        using var root = Ветвистое(60);
        var seen = new Dictionary<string, (bool IsDir, long Size, int Cnt)>();
        var order = new List<string>();
        var total = await FsOps.CrawlTree(root.Root, "", (rel, isDir, size, cnt, _) =>
        {
            lock (seen)
            {
                Assert.False(seen.ContainsKey(rel), $"дважды: {rel}");
                seen[rel] = (isDir, size, cnt);
                order.Add(rel);
            }
        }, []);
        Assert.Equal(180, total.Count);
        Assert.Equal(360, total.Size);
        var files = seen.Where(kv => !kv.Value.IsDir).Select(kv => kv.Key).ToList();
        Assert.Equal(180, files.Count);
        foreach (var (rel, v) in seen)
        {
            if (!v.IsDir) continue;
            var inside = seen.Keys.Where(k => k.StartsWith(rel + "/", StringComparison.Ordinal)).ToList();
            var sum = inside.Select(k => seen[k]).Where(x => !x.IsDir).ToList();
            Assert.Equal(sum.Count, v.Cnt);
            Assert.Equal(sum.Sum(x => x.Size), v.Size);
            foreach (var k in inside) Assert.True(order.IndexOf(k) < order.IndexOf(rel), $"{k} после {rel}");
        }
        var scanned = await FsOps.ScanFiles(root.Root);
        Assert.Equal(files.OrderBy(p => p, StringComparer.Ordinal), scanned.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal));
    }

    [Fact]
    public async Task обход_работниками_брошенное_из_onEntry_останавливает_обход_и_доходит_до_вызывающего()
    {
        using var root = Ветвистое(80);
        var calls = 0;
        var e = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            FsOps.CrawlTree(root.Root, "", (_, _, _, _, _) =>
            {
                if (Interlocked.Increment(ref calls) == 25) throw new InvalidOperationException("toobig");
            }, []));
        Assert.Equal("toobig", e.Message);
        var after = Volatile.Read(ref calls);
        await Task.Delay(200);
        // Работники доделывают только то, что уже держали в руках, - новых отчётов нет.
        Assert.True(Volatile.Read(ref calls) - after <= 40, $"после остановки ещё {calls - after} отчётов");

        var n = 0;
        await Assert.ThrowsAsync<OperationCanceledException>(() => FsOps.ScanFiles(root.Root, "", null, null, () =>
        {
            if (Interlocked.Increment(ref n) == 30) throw new OperationCanceledException();
        }));
    }

    // Нового в C#: обход работниками сверяется с простым рекурсивным на случайных
    // деревьях - файлы, папки и итоги до байта.
    [Fact]
    public async Task обход_работниками_совпадает_с_простым_рекурсивным_на_случайных_деревьях()
    {
        var rnd = new Random(20260926);
        for (var run = 0; run < 8; run++)
        {
            using var t = new TempDir();
            var dirs = new List<string> { "" };
            for (var i = 0; i < 40; i++)
            {
                var parent = dirs[rnd.Next(dirs.Count)];
                var name = rnd.Next(3) == 0 ? $"Папка{i}" : $"d{i}";
                var rel = parent == "" ? name : $"{parent}/{name}";
                if (rnd.Next(4) == 0) t.Write(rel, new string('x', rnd.Next(0, 300)));
                else
                {
                    t.Mkdir(rel);
                    dirs.Add(rel);
                }
            }

            var простой = Directory.EnumerateFiles(t.Root, "*", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(t.Root, f).Replace('\\', '/')).OrderBy(p => p, StringComparer.Ordinal).ToList();
            var простыеПапки = Directory.EnumerateDirectories(t.Root, "*", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(t.Root, f).Replace('\\', '/')).OrderBy(p => p, StringComparer.Ordinal).ToList();
            var байт = Directory.EnumerateFiles(t.Root, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);

            var папки = new List<string>();
            var скан = await FsOps.ScanFiles(t.Root, "", null, null, null, папки);
            var итог = await FsOps.CrawlTree(t.Root, "", (_, _, _, _, _) => { }, []);

            Assert.Equal(простой, скан.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal));
            Assert.Equal(простыеПапки, папки.OrderBy(p => p, StringComparer.Ordinal));
            Assert.Equal(простой.Count, итог.Count);
            Assert.Equal(байт, итог.Size);
        }
    }
}
