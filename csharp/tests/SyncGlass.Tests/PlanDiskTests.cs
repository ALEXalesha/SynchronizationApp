using SyncGlass.Core;
using static SyncGlass.Tests.TestUtil;

namespace SyncGlass.Tests;

// Перенос test/plan.test.js: тесты плана с живым сканом, выполнением и индексом обхода.
public class PlanDiskTests
{
    private static readonly DateTime When = new(2020, 1, 1, 0, 0, 0, DateTimeKind.Local);

    // Собирает индекс стороны ровно так же, как обработчик start-crawl.
    private static async Task<CrawlSide> IndexOf(string root)
    {
        var files = new Dictionary<string, (long, double)>(StringComparer.Ordinal);
        var dirs = new HashSet<string>(StringComparer.Ordinal);
        await FsOps.CrawlTree(root, "", (rel, isDir, size, _, mtime) =>
        {
            lock (files)
            {
                if (isDir) dirs.Add(rel);
                else files[rel] = (size, mtime ?? 0);
            }
        });
        return new CrawlSide(files, dirs, []);
    }

    // Сканер поверх индексов - подмена LiveScan.
    private static Scanner IndexScan(string srcRoot, CrawlSide srcIdx, CrawlSide dstIdx) =>
        (root, branch, excludes) => Task.FromResult(Plan.ScanFromIndex(root == srcRoot ? srcIdx : dstIdx, branch, excludes));

    private static Task<SyncPlan> Build(TempDir src, TempDir dst, string[] folders, string[]? excludes = null, Scanner? scan = null)
        => Plan.BuildRunPlan(src.Root, dst.Root, folders, excludes ?? [], scan ?? LiveScan);

    private static Task<ApplyResult> Apply(TempDir src, TempDir dst, SyncPlan plan, Action<Progress>? onProgress = null, Func<bool>? stop = null)
        => FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(), onProgress, stop);

    [Fact]
    public async Task перенос_между_двумя_выбранными_ветками_виден_как_перемещение()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("Документы/отчёт.pdf", "содержимое отчёта");
        src.Mkdir("Архив");
        CopyTree(src.Root, dst.Root);
        File.Move(src.P("Документы/отчёт.pdf"), src.P("Архив/отчёт.pdf"));

        var plan = await Build(src, dst, ["Документы", "Архив"]);

        var mv = Assert.Single(plan.Moves);
        Assert.Equal("Документы/отчёт.pdf", mv.From);
        Assert.Equal("Архив/отчёт.pdf", mv.To);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Trash);

        await Apply(src, dst, plan);
        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
    }

    [Fact]
    public async Task невыбранная_ветка_не_трогается_даже_если_файл_ушёл_туда()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("Выбрано/файл.txt", "данные");
        src.Write("Мимо/сосед.txt", "не трогать");
        CopyTree(src.Root, dst.Root);
        File.Delete(src.P("Выбрано/файл.txt"));

        var plan = await Build(src, dst, ["Выбрано"]);
        Assert.Empty(plan.Moves);
        Assert.Single(plan.Trash);

        await Apply(src, dst, plan);
        Assert.Equal("не трогать", Read(dst.Root, "Мимо/сосед.txt"));
        Assert.False(Exists(dst.Root, "Выбрано/файл.txt"));
    }

    [Fact]
    public async Task вложенная_ветка_создаётся_вместе_с_родителями()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("год/2026/квартал/итог.txt", "цифры");

        var plan = await Build(src, dst, ["год/2026"]);
        Assert.Contains("год", plan.Dirs.Create);
        Assert.Contains("год/2026", plan.Dirs.Create);

        await Apply(src, dst, plan);
        Assert.Equal("цифры", Read(dst.Root, "год/2026/квартал/итог.txt"));
    }

    [Fact]
    public async Task исключённая_ветка_не_попадает_ни_в_файлы_ни_в_папки()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("docs/2023/a.txt", "a");
        dst.Write("docs/2024/личное.txt", "приватное");
        dst.Mkdir("docs/2024/глубже");

        var plan = await Build(src, dst, ["docs"], ["docs/2024"]);
        var touched = plan.Copy.Select(e => e.Path).Concat(plan.Trash.Select(e => e.Path))
            .Concat(plan.Dirs.Create).Concat(plan.Dirs.Remove);
        Assert.DoesNotContain(touched, p => p.StartsWith("docs/2024", StringComparison.Ordinal));

        await Apply(src, dst, plan);
        Assert.Equal("приватное", Read(dst.Root, "docs/2024/личное.txt"));
    }

    [Fact]
    public async Task после_синхронизации_деревья_совпадают_полностью_повтор_не_находит_работы()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("Проект/код/main.js", "console.log(1)");
        src.Write("Проект/док/readme.md", "# привет");
        src.Mkdir("Проект/пусто");
        dst.Write("Проект/старое/мусор.tmp", "x");
        dst.Write("Проект/док/readme.md", "старая версия");

        var plan = await Build(src, dst, ["Проект"]);
        var res = await Apply(src, dst, plan);
        Assert.Empty(res.Failures);

        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
        Assert.False(Exists(dst.Root, FsOps.StageDir));

        var again = await Build(src, dst, ["Проект"]);
        Assert.Empty(again.Moves);
        Assert.Empty(again.Copy);
        Assert.Empty(again.Overwrite);
        Assert.Empty(again.Trash);
        Assert.Empty(again.Dirs.Create);
        Assert.Empty(again.Dirs.Remove);
    }

    [Fact]
    public async Task выбран_отдельный_файл_а_не_папка()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("заметки.txt", "новое");
        dst.Write("заметки.txt", "старое");
        dst.Write("другое.txt", "не трогать");

        var plan = await Build(src, dst, ["заметки.txt"]);
        Assert.Single(plan.Overwrite);
        Assert.Empty(plan.Dirs.Remove);

        await Apply(src, dst, plan);
        Assert.Equal("новое", Read(dst.Root, "заметки.txt"));
        Assert.Equal("не трогать", Read(dst.Root, "другое.txt"));
    }

    [Fact]
    public async Task countByFolder_раскладывает_работу_по_веткам_и_сходится_с_общим_итогом()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("A/новый.txt", "1");
        src.Write("B/тоже.txt", "2");
        dst.Write("B/лишний.txt", "3");

        string[] folders = ["A", "B"];
        var plan = await Build(src, dst, folders);
        var byFolder = Plan.CountByFolder(plan, folders);

        Assert.Equal(plan.Copy.Count, byFolder.Sum(p => p.Summary.Copy));
        Assert.Equal(plan.Trash.Count, byFolder.Sum(p => p.Summary.Trash));
        Assert.Equal(plan.Dirs.Create.Count + plan.Dirs.Remove.Count, byFolder.Sum(p => p.Summary.Dirs));
    }

    [Fact]
    public async Task родительская_папка_ветки_не_удаляется_если_на_источнике_она_есть()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        // 'Документы' есть на обеих сторонах, а 'Документы/2024' - только на приёмнике.
        src.Mkdir("Документы");
        dst.Write("Документы/2024/старое.txt", "выкинуть");

        var plan = await Build(src, dst, ["Документы/2024"]);
        Assert.Contains("Документы/2024", plan.Dirs.Remove);
        Assert.DoesNotContain("Документы", plan.Dirs.Remove);

        await Apply(src, dst, plan);
        Assert.True(Directory.Exists(dst.P("Документы")));
        Assert.False(Exists(dst.Root, "Документы/2024"));
    }

    [Fact]
    public async Task родительская_папка_создаётся_когда_её_нет_на_приёмнике()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("Документы/2024/новое.txt", "копировать");

        var plan = await Build(src, dst, ["Документы/2024"]);
        await Apply(src, dst, plan);

        Assert.Equal("копировать", Read(dst.Root, "Документы/2024/новое.txt"));
    }

    [Fact]
    public async Task ложный_перенос_по_размеру_и_дате_не_подменяет_содержимое_на_приёмнике()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("новое/данные.bin", "AAAA");
        dst.Write("старое/архив.bin", "BBBB"); // тот же размер, чужое содержимое
        var stamp = DateTimeOffset.FromUnixTimeMilliseconds(1700000000000).UtcDateTime;
        SetMtime(src.Root, "новое/данные.bin", stamp);
        SetMtime(dst.Root, "старое/архив.bin", stamp);

        var plan = await Build(src, dst, ["новое", "старое"]);
        Assert.Empty(plan.Moves);

        await Apply(src, dst, plan);
        Assert.Equal("AAAA", Read(dst.Root, "новое/данные.bin"));
        Assert.False(Exists(dst.Root, "старое/архив.bin"));
    }

    [Fact]
    public async Task на_источнике_папка_на_приёмнике_файл_с_тем_же_именем()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("отчёты/май.txt", "данные");
        dst.Write("отчёты", "а тут был файл");

        var plan = await Build(src, dst, ["отчёты"]);
        Assert.Equal(["отчёты"], plan.Conflicts);

        var res = await Apply(src, dst, plan);
        Assert.Empty(res.Failures);
        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
    }

    [Fact]
    public async Task на_источнике_файл_на_приёмнике_папка_с_тем_же_именем()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("отчёты", "теперь это файл");
        dst.Write("отчёты/май.txt", "старые данные");

        var plan = await Build(src, dst, ["отчёты"]);
        Assert.Equal(["отчёты"], plan.Conflicts);

        var res = await Apply(src, dst, plan);
        Assert.Empty(res.Failures);
        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
        Assert.Equal("теперь это файл", Read(dst.Root, "отчёты"));
    }

    [Fact]
    public async Task остановка_на_конфликте_типов_возвращает_приёмник_как_было()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("узел/файл.txt", "новое");
        dst.Write("узел", "исходный файл");
        var before = TreeOf(dst.Root);

        var plan = await Build(src, dst, ["узел"]);
        var res = await Apply(src, dst, plan, null, () => true);

        Assert.True(res.Cancelled);
        Assert.Equal(before, TreeOf(dst.Root));
        Assert.Equal("исходный файл", Read(dst.Root, "узел"));
    }

    [Fact]
    public async Task вложенная_ветка_получает_свои_счётчики_а_не_отдаёт_их_родителю()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/верх.txt", "В");
        src.Write("док/скрытое/мимо.txt", "М");
        src.Write("док/скрытое/нужное/глубоко.txt", "Г");

        // Отмечено 'док', снята отметка с 'док/скрытое', возвращена 'док/скрытое/нужное'.
        string[] folders = ["док", "док/скрытое/нужное"];
        var plan = await Build(src, dst, folders, ["док/скрытое"]);
        var by = Plan.CountByFolder(plan, folders).ToDictionary(p => p.Folder, p => p.Summary);

        Assert.Equal(1, by["док"].Copy);
        Assert.Equal(1, by["док/скрытое/нужное"].Copy);

        await Apply(src, dst, plan);
        Assert.False(Exists(dst.Root, "док/скрытое/мимо.txt"));
        Assert.Equal("Г", Read(dst.Root, "док/скрытое/нужное/глубоко.txt"));
    }

    [Fact]
    public async Task конфликт_типов_в_глубине_ветки_разбирается_за_один_запуск()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/узел/внутри.txt", "новое");
        dst.Write("док/узел", "а тут был файл");
        src.Write("док/второй", "файл");
        dst.Write("док/второй/старое.txt", "мусор");

        var plan = await Build(src, dst, ["док"]);
        Assert.Equal(["док/второй", "док/узел"], plan.Conflicts.OrderBy(p => p, StringComparer.Ordinal));

        var res = await Apply(src, dst, plan);
        Assert.Empty(res.Failures);
        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
        Assert.Equal("новое", Read(dst.Root, "док/узел/внутри.txt"));
        Assert.Equal("файл", Read(dst.Root, "док/второй"));

        var again = await Build(src, dst, ["док"]);
        Assert.Equal(0, Sync.Summarize(again).Total);
    }

    [Fact]
    public async Task остановка_на_глубоком_конфликте_возвращает_приёмник_как_было()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/узел/внутри.txt", "новое");
        dst.Write("док/узел", "исходный файл");
        dst.Write("док/сосед.txt", "не трогать");
        var before = TreeOf(dst.Root);

        var plan = await Build(src, dst, ["док"]);
        var res = await Apply(src, dst, plan, null, () => true);

        Assert.True(res.Cancelled);
        Assert.Equal(before, TreeOf(dst.Root));
        Assert.Equal("исходный файл", Read(dst.Root, "док/узел"));
    }

    // ---- Скан из индекса фонового обхода: источники разные, план обязан быть один ----

    [Fact]
    public async Task scanFromIndex_совпадает_с_живым_сканом_на_возвращённой_вложенной_ветке()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/сам.txt", "один");
        src.Write("док/а/пропустить.txt", "мимо");
        src.Write("док/а/б/вернули.txt", "нужен");

        string[] folders = ["док", "док/а/б"];
        string[] excludes = ["док/а"];
        var byScan = await Build(src, dst, folders, excludes);
        var byIndex = await Build(src, dst, folders, excludes, IndexScan(src.Root, await IndexOf(src.Root), await IndexOf(dst.Root)));

        static List<string> Paths(SyncPlan p) => p.Copy.Select(e => e.Path).OrderBy(x => x, StringComparer.Ordinal).ToList();
        Assert.Equal(Paths(byScan), Paths(byIndex));
        Assert.Equal(["док/а/б/вернули.txt", "док/сам.txt"], Paths(byIndex));
        Assert.Equal(Sync.Summarize(byScan), Sync.Summarize(byIndex));
    }

    [Fact]
    public async Task план_по_индексу_и_по_живому_скану_сходится_на_дереве_с_переносом_и_удалением()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/новый.txt", "новый");
        src.Write("док/глубже/переехал.txt", "тело");
        src.Write("док/общий.txt", "одинаково");
        dst.Write("док/переехал.txt", "тело");
        dst.Write("док/общий.txt", "одинаково");
        dst.Write("док/лишний.txt", "убрать");
        File.SetLastWriteTime(src.P("док/глубже/переехал.txt"), When);
        File.SetLastWriteTime(dst.P("док/переехал.txt"), When);
        foreach (var root in new[] { src, dst }) File.SetLastWriteTime(root.P("док/общий.txt"), When);

        var byScan = await Build(src, dst, ["док"]);
        var byIndex = await Build(src, dst, ["док"], null, IndexScan(src.Root, await IndexOf(src.Root), await IndexOf(dst.Root)));

        Assert.Equal(Sync.Summarize(byScan), Sync.Summarize(byIndex));
        Assert.Single(byIndex.Moves);
        Assert.Equal(byScan.Dirs.Create, byIndex.Dirs.Create);
        Assert.Equal(byScan.Dirs.Remove, byIndex.Dirs.Remove);
        Assert.Equal(["док/лишний.txt"], byIndex.Trash.Select(e => e.Path));
    }

    // ---- Регистр в путях ----

    [Fact]
    public async Task переименование_одного_регистра_не_стирает_файл_с_приёмника()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/Заметка.txt", "тело");
        dst.Write("док/заметка.txt", "тело");

        var plan = await Build(src, dst, ["док"]);
        await Apply(src, dst, plan);

        Assert.Equal(["док/", "док/Заметка.txt"], TreeOf(dst.Root));
        Assert.Equal("тело", Read(dst.Root, "док/Заметка.txt"));

        var again = await Build(src, dst, ["док"]);
        Assert.Equal(0, Sync.Summarize(again).Total);
    }

    // Нашёл дифференциальный прогон: внутренняя папка, написанная на приёмнике иначе,
    // давала вечную перезапись - каждый запуск снова копировал те же файлы.
    [Fact]
    public async Task разное_написание_внутренней_папки_не_заводит_вечную_перезапись()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/вложено/а.txt", "тело");
        dst.Write("док/ВЛОЖЕНО/а.txt", "тело");
        File.SetLastWriteTime(src.P("док/вложено/а.txt"), When);
        File.SetLastWriteTime(dst.P("док/ВЛОЖЕНО/а.txt"), When);

        var plan = await Build(src, dst, ["док"]);
        Assert.Equal(0, Sync.Summarize(plan).Total);

        await Apply(src, dst, plan);
        var again = await Build(src, dst, ["док"]);
        Assert.Equal(0, Sync.Summarize(again).Total);
        Assert.Equal(["док/", "док/ВЛОЖЕНО/", "док/ВЛОЖЕНО/а.txt"], TreeOf(dst.Root));
    }

    [Fact]
    public async Task ветка_написанная_в_регистре_другой_стороны_не_выглядит_пустой_в_индексе()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("док/а.txt", "тело");
        src.Write("док/б.txt", "тело2");
        dst.Write("Док/а.txt", "тело");
        dst.Write("Док/б.txt", "тело2");
        foreach (var (root, rel) in new[] { (src, "док/а.txt"), (dst, "Док/а.txt"), (src, "док/б.txt"), (dst, "Док/б.txt") })
            File.SetLastWriteTime(root.P(rel), When);

        // Интерфейс отдаёт ветку с написанием той стороны, что попала в список первой.
        var plan = await Build(src, dst, ["Док"], null, IndexScan(src.Root, await IndexOf(src.Root), await IndexOf(dst.Root)));

        Assert.Empty(plan.Trash);
        Assert.Empty(plan.Dirs.Remove);
    }

    [Fact]
    public async Task счётчик_ветки_учитывает_её_собственных_родителей()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("год/квартал/неделя/отчёт.txt", "данные");

        var plan = await Build(src, dst, ["год/квартал/неделя"]);
        var totals = Sync.Summarize(plan);
        var row = Assert.Single(Plan.CountByFolder(plan, ["год/квартал/неделя"]));

        Assert.Equal(["год", "год/квартал", "год/квартал/неделя"], plan.Dirs.Create);
        Assert.Equal(totals.Dirs, row.Summary.Dirs);
        Assert.Equal(totals.Total, row.Summary.Total);
    }

    // ---- Кандидаты в перемещения ----

    [Fact]
    public async Task одинаковые_имя_размер_и_дата_но_разное_содержимое_это_не_перемещение()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("д/новая/config.json", "AAAAA");
        dst.Write("д/старая/config.json", "BBBBB");
        File.SetLastWriteTime(src.P("д/новая/config.json"), When);
        File.SetLastWriteTime(dst.P("д/старая/config.json"), When);

        var plan = await Build(src, dst, ["д"]);
        Assert.Empty(plan.Moves);
        Assert.Equal(["д/новая/config.json"], plan.Copy.Select(e => e.Path));
        Assert.Equal(["д/старая/config.json"], plan.Trash.Select(e => e.Path));

        await Apply(src, dst, plan);
        Assert.Equal("AAAAA", Read(dst.Root, "д/новая/config.json"));
    }

    // Нового в C#: сверка содержимого не смогла прочитать кандидата (файл исчез между
    // сканом и сверкой) - это «не тот же», а не «тот же»: иначе приёмник переименует
    // свой файл под чужое имя без всякой проверки.
    [Fact]
    public async Task кандидат_которого_уже_нет_на_диске_не_становится_перемещением()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Mkdir("д/новая");
        dst.Write("д/старая/x.txt", "1");
        File.SetLastWriteTime(dst.P("д/старая/x.txt"), When);
        var mtime = FsOps.ToMs(File.GetLastWriteTimeUtc(dst.P("д/старая/x.txt")));

        Scanner scanner = async (root, branch, excludes) =>
        {
            var side = await LiveScan(root, branch, excludes);
            if (root != src.Root) return side;
            // Источник «видел» файл, которого на диске к сверке уже нет.
            return new ScanResult([new FileEntry("новая/x.txt", 1, mtime)], side.Dirs, side.Skipped);
        };

        var plan = await Build(src, dst, ["д"], null, scanner);
        Assert.Empty(plan.Moves);
        Assert.Equal(["д/новая/x.txt"], plan.Copy.Select(e => e.Path));
        Assert.Equal(["д/старая/x.txt"], plan.Trash.Select(e => e.Path));
    }

    [Fact]
    public async Task настоящее_перемещение_по_прежнему_обходится_переименованием()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("д/старая/отчёт.pdf", new string('x', 200000));
        CopyTree(src.Root, dst.Root);
        src.Mkdir("д/новая");
        File.Move(src.P("д/старая/отчёт.pdf"), src.P("д/новая/отчёт.pdf"));

        var plan = await Build(src, dst, ["д"]);
        Assert.Single(plan.Moves);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Trash);
    }

    // ---- Конфликт типа в предке ветки ----

    [Fact]
    public async Task предок_выбранной_ветки_файл_на_приёмнике_узел_убирается_ветка_доезжает()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("a/b/нужный.txt", "нужен");
        dst.Write("a", "на приёмнике это файл");

        var plan = await Build(src, dst, ["a/b"]);
        Assert.Equal(["a"], plan.Conflicts);

        var res = await Apply(src, dst, plan);
        Assert.Empty(res.Failures);
        Assert.Equal(["a/", "a/b/", "a/b/нужный.txt"], TreeOf(dst.Root));
    }

    [Fact]
    public async Task общий_конфликтный_предок_двух_веток_убирается_один_раз()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("a/b/один.txt", "1");
        src.Write("a/c/два.txt", "2");
        dst.Write("a", "на приёмнике это файл");

        var plan = await Build(src, dst, ["a/b", "a/c"]);
        Assert.Equal(["a"], plan.Conflicts);

        var res = await Apply(src, dst, plan);
        Assert.Empty(res.Failures);
        Assert.Equal(0, res.Unrecoverable);
        Assert.Equal(["a/", "a/b/", "a/b/один.txt", "a/c/", "a/c/два.txt"], TreeOf(dst.Root));
    }

    // Скан отдал этот файл отдельным списком: он есть, но размера мы не знаем. Файл,
    // названный целиком, обязан отсекать сам себя - иначе на приёмнике он лишний.
    [Fact]
    public async Task файл_закрытый_правами_на_источнике_не_уводит_копию_с_приёмника()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("данные/открытый.txt", "o");
        dst.Write("данные/открытый.txt", "o");
        dst.Write("данные/закрытый.txt", "z");

        Scanner scanner = async (root, branch, excludes) =>
        {
            var side = await LiveScan(root, branch, excludes);
            if (root != src.Root) return side;
            return new ScanResult(side.Files.Where(e => e.Path != "закрытый.txt").ToList(), side.Dirs, ["закрытый.txt"]);
        };

        var plan = await Build(src, dst, ["данные"], null, scanner);

        Assert.Empty(plan.Trash);
        Assert.Empty(plan.Copy);
        Assert.Equal(["данные/закрытый.txt"], plan.Skipped);

        await Apply(src, dst, plan);
        Assert.Equal("z", Read(dst.Root, "данные/закрытый.txt"));
    }

    [Fact]
    public async Task остановка_возвращает_на_место_файл_снятый_конфликтом_в_предке()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("a/b/нужный.txt", "нужен");
        dst.Write("a", "на приёмнике это файл");
        var before = TreeOf(dst.Root);

        var plan = await Build(src, dst, ["a/b"]);
        var steps = 0;
        var res = await Apply(src, dst, plan, _ => Interlocked.Increment(ref steps), () => Volatile.Read(ref steps) >= 2);

        Assert.True(res.Cancelled);
        Assert.Equal(before, TreeOf(dst.Root));
        Assert.Equal("на приёмнике это файл", Read(dst.Root, "a"));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }
}
