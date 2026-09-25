using System.Diagnostics;
using SyncGlass.Core;

namespace SyncGlass.Tests;

// Перенос test/plan.test.js. Здесь - тесты, которым не нужны живой скан и выполнение
// плана; остальные - в PlanDiskTests (после переноса FsOps.ScanFiles и ApplyPlan).
public class PlanTests
{
    private static CrawlSide Index(IEnumerable<(string Rel, long Size)> files, IEnumerable<string> dirs, IEnumerable<string>? skipped = null)
    {
        var map = new Dictionary<string, (long Size, double MtimeMs)>(StringComparer.Ordinal);
        foreach (var (rel, size) in files) map[rel] = (size, 0);
        return new CrawlSide(map, new HashSet<string>(dirs, StringComparer.Ordinal), (skipped ?? []).ToList());
    }

    [Fact]
    public void ancestorsOf_разбирает_цепочку_родителей()
    {
        Assert.Equal(["a", "a/b"], Plan.AncestorsOf("a/b/c"));
        Assert.Empty(Plan.AncestorsOf("одна"));
    }

    // ---- Скан из индекса фонового обхода ----

    [Fact]
    public void scanFromIndex_исключение_действует_только_внутри_своей_ветки()
    {
        var idx = Index(
            [("док/сам.txt", 1), ("док/а/пропустить.txt", 1), ("док/а/б/вернули.txt", 1)],
            ["док", "док/а", "док/а/б"]);

        // Для ветки 'док' запрет 'док/а' действует и накрывает всё вложенное.
        var верх = Plan.ScanFromIndex(idx, "док", ["док/а"]);
        Assert.Equal(["сам.txt"], верх.Files.Select(f => f.Path));
        Assert.Empty(верх.Dirs);

        // Для ветки 'док/а/б' тот же запрет уже не действует: отметка точнее.
        var низ = Plan.ScanFromIndex(idx, "док/а/б", ["док/а"]);
        Assert.Equal(["вернули.txt"], низ.Files.Select(f => f.Path));
    }

    [Fact]
    public void scanFromIndex_находит_ветку_независимо_от_регистра()
    {
        var idx = Index([("Док/а.txt", 1), ("Док/вложено/б.txt", 2)], ["Док", "Док/вложено"]);
        var got = Plan.ScanFromIndex(idx, "док", ["док/вложено"]);
        Assert.Equal(["а.txt"], got.Files.Select(e => e.Path));
        Assert.Empty(got.Dirs);
    }

    // Нового в C#: закрытый правами корень ветки - пустая строка, как у живого скана.
    [Fact]
    public void scanFromIndex_закрытый_корень_ветки_пустой_строкой()
    {
        var idx = Index([], ["Док"], ["док", "Док/внутри"]);
        var got = Plan.ScanFromIndex(idx, "Док", []);
        Assert.Equal(["", "внутри"], got.Skipped);
    }

    // Нового в C# (ответ сверен с JS): закрыт сам корень ветки на источнике - сравнивать
    // нечего вовсе, и приёмник этой ветки не трогается. Иначе закрытая ветка читалась бы
    // пустой, а пустой источник - это «на приёмнике всё лишнее».
    [Fact]
    public async Task planForBranch_закрытый_корень_ветки_не_трогает_приёмник()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Mkdir("закрыто");
        dst.Mkdir("закрыто");
        Scanner scan = (root, _, _) => Task.FromResult(root == src.Root
            ? new ScanResult([], [], [""])
            : new ScanResult([new FileEntry("а.txt", 1, 0)], ["под"], []));

        var b = await Plan.PlanForBranch(src.Root, dst.Root, "закрыто", [], scan);

        Assert.Empty(b.Plan.Copy);
        Assert.Empty(b.Plan.Trash);
        Assert.Equal(["закрыто"], b.SrcDirs);
        Assert.Equal(["закрыто"], b.DstDirs);
        Assert.Equal(["закрыто"], b.Skipped);
    }

    // Нового в C# (сверено с JS): ветка приходит в написании одной стороны, пути плана -
    // в написании другой; счётчики находят ветку без учёта регистра.
    [Fact]
    public void countByFolder_находит_ветку_без_учёта_регистра()
    {
        var plan = new SyncPlan { Dirs = new DirPlan { Create = ["ДОК/под"] } };
        plan.Copy.Add(new FileEntry("док/а.txt", 1, 0));
        var row = Assert.Single(Plan.CountByFolder(plan, ["Док"]));
        Assert.Equal(new Summary(0, 1, 0, 0, 0, 1, 2), row.Summary);
    }

    // Родители ветки создаются планом, но внутрь ветки не вложены: без разметки
    // родителей сумма по строкам предпросмотра не сходилась с шапкой. (Сверено с JS.)
    [Fact]
    public void countByFolder_родители_ветки_в_её_счёт()
    {
        var plan = new SyncPlan { Dirs = new DirPlan { Create = ["год", "год/квартал", "год/квартал/неделя"] } };
        var row = Assert.Single(Plan.CountByFolder(plan, ["год/квартал/неделя"]));
        Assert.Equal(3, row.Summary.Dirs);
    }

    // Общего родителя получает самая длинная ветка, как у перебора от длинных к коротким,
    // и не зависит от порядка отметок. (Сверено с JS: a/b - 0, a/b/c/d - 1.)
    [Fact]
    public void countByFolder_общий_родитель_достаётся_самой_длинной_ветке()
    {
        var plan = new SyncPlan { Dirs = new DirPlan { Create = ["a"] } };
        var rows = Plan.CountByFolder(plan, ["a/b", "a/b/c/d"]);
        Assert.Equal(0, rows[0].Summary.Dirs);
        Assert.Equal(1, rows[1].Summary.Dirs);
    }

    // ---- Законы масштаба: произведения двух законных пределов ----

    // «Выбрать все» на папке с тысячами узлов верхнего уровня - законный сценарий.
    // Перебор всех веток на каждый путь давал 5000 × 100 тысяч; ветка ищется подъёмом.
    [Fact]
    public void счётчики_по_веткам_не_платят_произведением_веток_на_файлы()
    {
        var folders = new List<string>();
        var plan = new SyncPlan();
        for (var i = 0; i < 5000; i++)
        {
            folders.Add($"ветка{i}");
            for (var j = 0; j < 20; j++) plan.Copy.Add(new FileEntry($"ветка{i}/файл{j}.txt", 1, 0));
        }
        plan.Dirs = new DirPlan { Create = folders.ToList() };

        var sw = Stopwatch.StartNew();
        var perFolder = Plan.CountByFolder(plan, folders);
        sw.Stop();

        Assert.Equal(5000, perFolder.Count);
        Assert.Equal(20, perFolder[0].Summary.Copy);
        Assert.Equal(1, perFolder[0].Summary.Dirs);
        Assert.Equal(plan.Copy.Count, perFolder.Sum(pf => pf.Summary.Copy));
        Assert.True(sw.ElapsedMilliseconds < 2000, $"счётчики заняли {sw.ElapsedMilliseconds} мс - похоже на перебор всех веток");
    }

    // Шара, где папку листать дают, а stat по файлам нет, отдаёт запись на каждый файл:
    // тысяча закрытых на 50 тысяч видимых - десять секунд при переборе списка на путь.
    [Fact]
    public async Task закрытые_правами_узлы_не_платят_произведением_на_файлы_ветки()
    {
        var skipped = Enumerable.Range(0, 2000).Select(i => $"закрыт{i}.dat").ToList();
        var files = Enumerable.Range(0, 50000).Select(i => new FileEntry($"видно/ф{i}.txt", 1, 0)).ToList();
        Scanner scan = (_, _, _) => Task.FromResult(new ScanResult(files, ["видно"], skipped));

        // Источник - настоящая папка (иначе сканер не позовут), приёмника нет вовсе:
        // тогда всё видимое встаёт в copy и его легко пересчитать.
        using var t = new TempDir();
        var sw = Stopwatch.StartNew();
        var branch = await Plan.PlanForBranch(t.Root, t.P("нет-такой"), "", [], scan);
        sw.Stop();

        Assert.Equal(50000, branch.Plan.Copy.Count);
        Assert.Equal(2000, branch.Skipped.Count);
        Assert.True(sw.ElapsedMilliseconds < 2000, $"план ветки занял {sw.ElapsedMilliseconds} мс - похоже на перебор всего списка");
    }

    // Сотня снятых веток на двести тысяч файлов индекса - произведение, которое видно
    // только секундомером и только с включённым подсчётом размеров.
    [Fact]
    public void исключения_не_платят_произведением_на_файлы_индекса()
    {
        var files = new List<(string, long)>();
        var dirs = new HashSet<string>();
        for (var i = 0; i < 200000; i++)
        {
            var d = $"ветка/под{i % 2000}";
            dirs.Add(d);
            files.Add(($"{d}/файл{i}.txt", 1));
        }
        var excludes = Enumerable.Range(0, 800).Select(i => $"ветка/под{i}").ToList();
        var idx = Index(files, dirs);

        var sw = Stopwatch.StartNew();
        var scan = Plan.ScanFromIndex(idx, "ветка", excludes);
        sw.Stop();

        Assert.Equal(120000, scan.Files.Count);
        Assert.Equal(1200, scan.Dirs.Count);
        Assert.True(sw.ElapsedMilliseconds < 2000, $"разбор индекса занял {sw.ElapsedMilliseconds} мс - похоже на перебор исключений");
    }

    // 5000 веток на 105 тысяч узлов и две стороны - 83 секунды до правки.
    [Fact]
    public void ветки_не_платят_произведением_на_весь_индекс()
    {
        var files = new List<(string, long)>();
        var dirs = new List<string>();
        var folders = new List<string>();
        for (var i = 0; i < 5000; i++)
        {
            folders.Add($"ветка{i}");
            dirs.Add($"ветка{i}");
            for (var j = 0; j < 20; j++) files.Add(($"ветка{i}/файл{j}.txt", 1));
        }
        var idx = Index(files, dirs);

        var sw = Stopwatch.StartNew();
        var groups = Plan.GroupIndexByBranch(idx, folders, []);
        sw.Stop();

        Assert.Equal(5000, groups.Count);
        Assert.Equal(20, groups["ветка0"].Files.Count);
        Assert.Equal("файл0.txt", groups["ветка0"].Files[0].Path);
        Assert.Equal(idx.Files.Count, groups.Values.Sum(g => g.Files.Count));
        Assert.True(sw.ElapsedMilliseconds < 2000, $"раскладка индекса заняла {sw.ElapsedMilliseconds} мс - похоже на проход по индексу на каждую ветку");
    }

    // 5000 веток на 30 тысяч исключений - 88 секунд до правки, и платит за них тот,
    // у кого подсчёт размеров выключен.
    [Fact]
    public void исключения_раскладываются_по_веткам_и_не_платят_произведением()
    {
        var folders = Enumerable.Range(0, 5000).Select(i => $"ветка{i}").ToList();
        var excludes = Enumerable.Range(0, 30000).Select(i => $"ветка{i % 5000}/под{i}/файл.txt").ToList();

        // Меряем ровно то, что делает запуск: раскладка один раз, выборка - на каждую
        // ветку и на каждую из двух сторон.
        var sw = Stopwatch.StartNew();
        var byBranch = Plan.GroupExcludesByBranch(excludes);
        var отобрано = 0;
        foreach (var f in folders)
        {
            отобрано += byBranch.GetValueOrDefault(f)?.Count ?? 0;
            отобрано += byBranch.GetValueOrDefault(f)?.Count ?? 0;
        }
        sw.Stop();

        Assert.Equal(60000, отобрано);
        Assert.Equal(6, byBranch["ветка0"].Count);
        Assert.Contains("под0/файл.txt", byBranch["ветка0"]);
        Assert.DoesNotContain(byBranch["ветка0"], p => p.StartsWith("ветка"));
        Assert.True(sw.ElapsedMilliseconds < 2000, $"раскладка исключений заняла {sw.ElapsedMilliseconds} мс - похоже на перебор списка на ветку");
    }

    [Fact]
    public void исключение_достаётся_каждой_ветке_предку_и_находится_в_любом_регистре()
    {
        var byBranch = Plan.GroupExcludesByBranch(["док/а/б/нельзя.txt", "верх.txt"]);

        Assert.Equal(["нельзя.txt"], byBranch["док/а/б"]);
        Assert.Equal(["б/нельзя.txt"], byBranch["док/а"]);
        Assert.Equal(["а/б/нельзя.txt"], byBranch["док"]);
        Assert.Same(byBranch[Paths.CiKey("ДОК")], byBranch["док"]);
        Assert.False(byBranch.ContainsKey(""), "исключение верхнего уровня ветке не принадлежит");
    }

    // План разбирает ветки по одной и спрашивал у диска тип ветки и всей цепочки
    // родителей - общий предок читался заново на каждую ветку, строго по очереди.
    // Меряем не секундомером, а двумя счётчиками: сколько обращений всего и сколько
    // держалось в воздухе разом (подменённый stat, как в JS-тесте).
    [Fact]
    public async Task ветки_не_платят_произведением_на_обращения_к_диску()
    {
        var folders = Enumerable.Range(0, 1500).Select(i => $"год/квартал{i % 4}/ветка{i}").ToList();
        var вызовов = 0;
        var вВоздухе = 0;
        var разом = 0;
        FsOps.StatOverride.Value = async _ =>
        {
            Interlocked.Increment(ref вызовов);
            var now = Interlocked.Increment(ref вВоздухе);
            lock (folders) if (now > разом) разом = now;
            await Task.Yield();
            Interlocked.Decrement(ref вВоздухе);
            return FileAttributes.Directory;
        };
        Scanner пусто = (_, _, _) => Task.FromResult(ScanResult.Empty());
        try
        {
            await Plan.BuildRunPlan("/и", "/п", folders, [], пусто);

            // 1500 веток + 4 квартала + 'год' на две стороны - 3010 разных узлов.
            Assert.True(вызовов <= 3200, $"{вызовов} обращений к диску - похоже на чтение предков заново");
            // Одна ветка сама по себе даёт шесть обращений разом, порог ловит именно пачку.
            Assert.True(разом >= 12, $"разом всего {разом} обращений - похоже на очередь по ветке");
        }
        finally
        {
            FsOps.StatOverride.Value = null;
        }
    }
}
