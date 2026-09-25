using SyncGlass.Core;
using static SyncGlass.Tests.TestUtil;

namespace SyncGlass.Tests;

// Перенос test/fsops.test.js: скан, обход, выполнение плана, остановка и откат,
// служебная папка.
public class FsOpsApplyTests
{
    private static SyncPlan PlanOf(List<FileEntry> src, List<FileEntry> dst) => Sync.PlanSync(src, dst);

    [Fact]
    public async Task scanFiles_обходит_вложенные_папки_и_пропускает_несуществующие()
    {
        using var t = new TempDir();
        t.Write("a.txt", "hello");
        t.Write("sub/b.txt", "world!!");
        var files = await Scan(t.Root);
        var byPath = files.ToDictionary(f => f.Path);
        Assert.True(byPath.ContainsKey("a.txt"));
        Assert.True(byPath.ContainsKey("sub/b.txt"));
        Assert.Equal(5, byPath["a.txt"].Size);
        Assert.Empty(await Scan(t.P("nope")));
    }

    [Fact]
    public async Task синхронизация_вложенной_ветки_не_трогает_соседей()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("docs/2023/old.txt", "src-2023");
        src.Write("docs/2024/new.txt", "src-2024");
        src.Write("pics/photo.txt", "src-pic");
        dst.Write("docs/2023/old.txt", "DST-2023-different");
        dst.Write("docs/2024/stale.txt", "to-remove");
        dst.Write("pics/photo.txt", "DST-pic-different");

        // Пользователь выбрал только docs/2024.
        foreach (var folder in new[] { "docs/2024" })
        {
            var plan = PlanOf(await Scan(src.P(folder)), await Scan(dst.P(folder)));
            await FsOps.ApplyPlan(src.P(folder), dst.P(folder), plan, MockTrash());
        }

        Assert.Equal("src-2024", Read(dst.Root, "docs/2024/new.txt"));
        Assert.False(Exists(dst.Root, "docs/2024/stale.txt"));
        Assert.Equal("DST-2023-different", Read(dst.Root, "docs/2023/old.txt"));
        Assert.Equal("DST-pic-different", Read(dst.Root, "pics/photo.txt"));
    }

    [Fact]
    public async Task listChildren_возвращает_и_папки_и_файлы_с_пометкой_типа()
    {
        using var t = new TempDir();
        t.Write("sub/x.txt", "1");
        t.Write("file.txt", "2");
        var (items, ok) = await FsOps.ListChildren(t.Root);
        var byName = items.ToDictionary(c => c.Name, c => c.IsDir);
        Assert.True(ok);
        Assert.True(byName["sub"]);
        Assert.False(byName["file.txt"]);
        Assert.Equal(2, items.Count);
    }

    // Нового в C#: нечитаемая сторона - Ok=false, а не пустая «прочитанная» папка.
    [Fact]
    public async Task listChildren_нет_папки_ok_false()
    {
        using var t = new TempDir();
        var (items, ok) = await FsOps.ListChildren(t.P("нет"));
        Assert.False(ok);
        Assert.Empty(items);
    }

    [Fact]
    public async Task listChildren_с_датой_отдаёт_дату_без_неё_ноль()
    {
        using var t = new TempDir();
        t.Write("f.txt", "1", new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        var with = (await FsOps.ListChildren(t.Root, true)).Items.Single();
        var without = (await FsOps.ListChildren(t.Root)).Items.Single();
        Assert.Equal(FsOps.ToMs(new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc)), with.MtimeMs);
        Assert.Equal(0, without.MtimeMs);
    }

    [Fact]
    public async Task crawlTree_считает_размеры_и_количество_файлов_по_узлам()
    {
        using var t = new TempDir();
        t.Write("docs/a.txt", "AAAAA"); // 5 байт
        t.Write("docs/sub/b.txt", "BB"); // 2 байта
        t.Write("root.txt", "CCC"); // 3 байта

        var seen = new Dictionary<string, (bool IsDir, long Size, int Cnt)>();
        var total = await FsOps.CrawlTree(t.Root, "", (rel, isDir, size, cnt, _) =>
        {
            lock (seen) seen[rel] = (isDir, size, cnt);
        });

        Assert.Equal(10, total.Size);
        Assert.Equal(3, total.Count);
        Assert.True(seen["docs"].IsDir);
        Assert.Equal(7, seen["docs"].Size); // 5 + 2
        Assert.Equal(2, seen["docs"].Cnt);
        Assert.False(seen["root.txt"].IsDir);
        Assert.Equal(3, seen["root.txt"].Size);
    }

    [Fact]
    public async Task scanFiles_пропускает_исключённые_ветки()
    {
        using var t = new TempDir();
        t.Write("keep/a.txt", "1");
        t.Write("skip/b.txt", "2");
        t.Write("skip/deep/c.txt", "3");
        var files = await FsOps.ScanFiles(t.Root, "", null, ["skip"]);
        Assert.Equal(["keep/a.txt"], files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal));
    }

    [Fact]
    public async Task исключённая_подпапка_не_копируется_и_не_удаляется()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("docs/2024/a.txt", "src-a");
        src.Write("docs/2023/b.txt", "src-b");
        src.Write("docs/root.txt", "src-root");
        dst.Write("docs/2024/OLD.txt", "dst-old"); // в исключённой ветке
        dst.Write("docs/extra.txt", "dst-extra"); // лишний, НЕ исключён

        string[] ex = ["2024"];
        var plan = PlanOf(await FsOps.ScanFiles(src.P("docs"), "", null, ex), await FsOps.ScanFiles(dst.P("docs"), "", null, ex));
        await FsOps.ApplyPlan(src.P("docs"), dst.P("docs"), plan, MockTrash());

        Assert.Equal("dst-old", Read(dst.Root, "docs/2024/OLD.txt"));
        Assert.False(Exists(dst.Root, "docs/2024/a.txt"));
        Assert.Equal("src-b", Read(dst.Root, "docs/2023/b.txt"));
        Assert.False(Exists(dst.Root, "docs/extra.txt"));
    }

    [Fact]
    public async Task applyPlan_не_падает_на_ошибке_файла_копит_failures_и_продолжает()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("a.txt", "A");
        src.Write("b.txt", "B");
        dst.Write("x.txt", "X"); // лишний → в trash, но trashFn бросит EPERM

        var plan = PlanOf(await Scan(src.Root), await Scan(dst.Root));
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, (_, _) => throw new FsException("EPERM", "operation not permitted"));

        Assert.Equal("A", Read(dst.Root, "a.txt"));
        Assert.Equal("B", Read(dst.Root, "b.txt"));
        var f = Assert.Single(res.Failures);
        Assert.Equal("trash", f.Action);
        Assert.Equal("EPERM", f.Code);
    }

    [Fact]
    public async Task applyPlan_параллельно_обрабатывает_много_файлов_корректно()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        for (var i = 0; i < 200; i++) src.Write($"sub{i % 7}/f{i}.txt", $"data-{i}");
        for (var i = 0; i < 50; i++) dst.Write($"old/x{i}.txt", "stale");

        var plan = PlanOf(await Scan(src.Root), await Scan(dst.Root));
        var trashed = new List<string>();
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(trashed));

        Assert.Empty(res.Failures);
        Assert.Equal(res.Total, res.Done);
        for (var i = 0; i < 200; i++) Assert.Equal($"data-{i}", Read(dst.Root, $"sub{i % 7}/f{i}.txt"));
        // Все 50 лишних файлов удалены одной пачкой.
        Assert.Single(trashed);
        Assert.Equal(50, res.Trashed);
        for (var i = 0; i < 50; i++) Assert.False(Exists(dst.Root, $"old/x{i}.txt"));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    [Fact]
    public async Task applyPlan_копирует_перезаписывает_и_удаляет()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("a.txt", "new file");
        src.Write("b.txt", "updated content");
        dst.Write("b.txt", "old");
        dst.Write("c.txt", "to be removed");

        var plan = PlanOf(await Scan(src.Root), await Scan(dst.Root));
        var trashed = new List<string>();
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(trashed));

        Assert.Equal(3, res.Total); // copy a, overwrite b, trash c
        Assert.Equal("new file", Read(dst.Root, "a.txt"));
        Assert.Equal("updated content", Read(dst.Root, "b.txt"));
        Assert.False(Exists(dst.Root, "c.txt"));
        Assert.Single(trashed);

        // Повторный проход не находит различий (дата перенесена при копировании).
        var plan2 = PlanOf(await Scan(src.Root), await Scan(dst.Root));
        Assert.Equal(0, plan2.Copy.Count + plan2.Overwrite.Count + plan2.Trash.Count);
    }

    // ---- Перемещения ----

    [Fact]
    public async Task перемещение_файла_в_другую_папку_распознаётся_и_не_копируется_заново()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("A/big.bin", new string('x', 4096));
        src.Write("A/stay.txt", "stay");
        CopyTree(src.Root, dst.Root);
        src.Mkdir("B");
        File.Move(src.P("A/big.bin"), src.P("B/big.bin"));

        var plan = Sync.DetectMoves(PlanOf(await Scan(src.Root), await Scan(dst.Root)));
        var mv = Assert.Single(plan.Moves);
        Assert.Equal("A/big.bin", mv.From);
        Assert.Equal("B/big.bin", mv.To);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Trash);

        var trashed = new List<string>();
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(trashed));
        Assert.Empty(res.Failures);
        Assert.Equal(new string('x', 4096), Read(dst.Root, "B/big.bin"));
        Assert.False(Exists(dst.Root, "A/big.bin"));
        Assert.Empty(trashed); // ничего не удалялось
    }

    [Fact]
    public async Task переименование_папки_это_перемещения_всех_её_файлов()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        for (var i = 0; i < 5; i++) src.Write($"Старая/f{i}.txt", $"данные-{i}");
        CopyTree(src.Root, dst.Root);
        Directory.Move(src.P("Старая"), src.P("Новая"));

        var srcDirs = new List<string>();
        var dstDirs = new List<string>();
        var plan = Sync.DetectMoves(PlanOf(await Scan(src.Root, srcDirs), await Scan(dst.Root, dstDirs)));
        plan.Dirs = Sync.PlanDirs(srcDirs, dstDirs);

        Assert.Equal(5, plan.Moves.Count);
        Assert.Empty(plan.Copy);
        Assert.Equal(["Новая"], plan.Dirs.Create);
        Assert.Equal(["Старая"], plan.Dirs.Remove);

        await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());
        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
    }

    [Fact]
    public void одинаковые_размер_дата_и_имя_в_разных_папках_перемещение_не_угадывается()
    {
        var plan = Sync.DetectMoves(PlanOf(
            [new("c/doc.txt", 10, 5000), new("d/doc.txt", 10, 5000)],
            [new("a/doc.txt", 10, 5000), new("b/doc.txt", 10, 5000)]));
        Assert.Empty(plan.Moves);
        Assert.Equal(2, plan.Copy.Count);
        Assert.Equal(2, plan.Trash.Count);
    }

    // Размер и дата до миллисекунды совпадают и у совершенно разных файлов (распаковка
    // архива, git checkout, robocopy) - перенос с переименованием не угадываем.
    [Fact]
    public void разные_имена_не_признаются_переносом_даже_при_совпадении_размера_и_даты()
    {
        var plan = Sync.DetectMoves(PlanOf([new("Архив/отчёт-2024.pdf", 999, 7000)], [new("Входящие/scan001.pdf", 999, 7000)]));
        Assert.Empty(plan.Moves);
        Assert.Single(plan.Copy);
        Assert.Single(plan.Trash);
    }

    [Fact]
    public void перенос_с_сохранением_имени_по_прежнему_ловится()
    {
        var plan = Sync.DetectMoves(PlanOf([new("Архив/2024/отчёт.pdf", 999, 7000)], [new("Входящие/отчёт.pdf", 999, 7000)]));
        var mv = Assert.Single(plan.Moves);
        Assert.Equal("Входящие/отчёт.pdf", mv.From);
        Assert.Equal("Архив/2024/отчёт.pdf", mv.To);
    }

    [Fact]
    public async Task пустые_папки_создаются_и_лишние_убираются()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Mkdir("ПустаяНовая");
        src.Write("Общая/a.txt", "a");
        dst.Write("Общая/a.txt", "a");
        dst.Mkdir("Лишняя/Глубже");

        var srcDirs = new List<string>();
        var dstDirs = new List<string>();
        var plan = PlanOf(await Scan(src.Root, srcDirs), await Scan(dst.Root, dstDirs));
        plan.Dirs = Sync.PlanDirs(srcDirs, dstDirs);
        // Глубокие первыми, иначе rmdir родителя упрётся в непустую папку.
        Assert.Equal(["Лишняя/Глубже", "Лишняя"], plan.Dirs.Remove);

        await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());
        Assert.Equal(TreeOf(src.Root), TreeOf(dst.Root));
    }

    [Fact]
    public async Task rmdir_не_сносит_папку_в_которой_осталось_исключённое()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        dst.Write("Лишняя/секрет.txt", "не трогать");

        var plan = PlanOf([], []);
        plan.Dirs = new DirPlan { Remove = ["Лишняя"] };
        await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());

        Assert.Equal("не трогать", Read(dst.Root, "Лишняя/секрет.txt"));
    }

    // ---- Остановка и откат ----

    [Fact]
    public async Task остановка_откатывает_копирование_перезапись_удаление_и_перемещение()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("move-me.bin", "MOVED");
        src.Write("upd.txt", "новое содержимое");
        for (var i = 0; i < 40; i++) src.Write($"new/n{i}.txt", $"new-{i}");
        src.Mkdir("НоваяПустая");

        dst.Write("old/move-me.bin", "MOVED");
        dst.Write("upd.txt", "старое");
        for (var i = 0; i < 40; i++) dst.Write($"stale/s{i}.txt", $"stale-{i}");

        // Дата у перемещаемого файла должна совпасть, иначе пара не найдётся.
        SetMtime(dst.Root, "old/move-me.bin", File.GetLastWriteTimeUtc(src.P("move-me.bin")));

        var before = TreeOf(dst.Root);
        var updBefore = Read(dst.Root, "upd.txt");

        var srcDirs = new List<string>();
        var dstDirs = new List<string>();
        var plan = Sync.DetectMoves(PlanOf(await Scan(src.Root, srcDirs), await Scan(dst.Root, dstDirs)));
        plan.Dirs = Sync.PlanDirs(srcDirs, dstDirs);
        Assert.Single(plan.Moves);

        // Останавливаем на середине работы.
        var seen = 0;
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(), _ => Interlocked.Increment(ref seen),
                                        () => Volatile.Read(ref seen) >= 20);

        Assert.True(res.Cancelled);
        Assert.Equal(before, TreeOf(dst.Root));
        Assert.Equal(updBefore, Read(dst.Root, "upd.txt"));
        Assert.Equal("MOVED", Read(dst.Root, "old/move-me.bin"));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    // Нового в C#: тест выше останавливается на 20-м шаге, а до удаления там 80 шагов -
    // фаза удаления в откат не попадала вовсе. Здесь остановка приходит посреди неё.
    [Fact]
    public async Task остановка_посреди_удаления_возвращает_отложенное()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        for (var i = 0; i < 30; i++) dst.Write($"лишнее/s{i}.txt", $"stale-{i}");
        var before = TreeOf(dst.Root);

        var plan = PlanOf([], await Scan(dst.Root));
        var seen = 0;
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(), _ => Interlocked.Increment(ref seen),
                                        () => Volatile.Read(ref seen) >= 10);

        Assert.True(res.Cancelled);
        Assert.True(seen >= 10, "остановка пришла посреди фазы удаления");
        Assert.Equal(before, TreeOf(dst.Root));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    // Нового в C#: скрытые и системные файлы Node видит, значит и план обязан.
    [Fact]
    public async Task скрытые_и_системные_файлы_видны_скану_и_листингу()
    {
        using var t = new TempDir();
        t.Write("desktop.ini", "x");
        t.Write("папка/.скрытый", "y");
        File.SetAttributes(t.P("desktop.ini"), FileAttributes.Hidden | FileAttributes.System);
        File.SetAttributes(t.P("папка/.скрытый"), FileAttributes.Hidden);

        var files = (await Scan(t.Root)).Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal);
        Assert.Equal(["desktop.ini", "папка/.скрытый"], files);
        Assert.Contains("desktop.ini", (await FsOps.ListChildren(t.Root)).Items.Select(c => c.Name));
    }

    [Fact]
    public async Task оборванный_запуск_restoreStage_возвращает_оригиналы_из_служебной_папки()
    {
        using var dst = new TempDir();
        dst.Write($"{FsOps.StageDir}/docs/важное.txt", "оригинал");
        dst.Write($"{FsOps.StageDir}/корень.txt", "тоже оригинал");

        var restored = await FsOps.RestoreStage(dst.Root);
        Assert.Equal(2, restored);
        Assert.Equal("оригинал", Read(dst.Root, "docs/важное.txt"));
        Assert.Equal("тоже оригинал", Read(dst.Root, "корень.txt"));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    [Fact]
    public async Task служебная_папка_не_видна_обходам_и_не_попадает_в_план()
    {
        using var t = new TempDir();
        t.Write("обычный.txt", "1");
        t.Write($"{FsOps.StageDir}/спрятанный.txt", "2");

        var dirs = new List<string>();
        var files = await Scan(t.Root, dirs);
        Assert.Equal(["обычный.txt"], files.Select(f => f.Path));
        Assert.Empty(dirs);
        Assert.Equal(["обычный.txt"], (await FsOps.ListChildren(t.Root)).Items.Select(c => c.Name));
    }

    // ---- Источник исчезает между планом и применением ----

    [Fact]
    public async Task источник_исчез_перед_перезаписью_оригинал_на_приёмнике_остаётся()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("отчёт.txt", "новое");
        dst.Write("отчёт.txt", "старое");

        var plan = new SyncPlan { Overwrite = [new FileEntry("отчёт.txt", 5, FsOps.ToMs(DateTime.UtcNow))] };
        File.Delete(src.P("отчёт.txt")); // файл пропадает уже после того, как план построен

        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());

        Assert.Equal("старое", Read(dst.Root, "отчёт.txt"));
        Assert.Equal([new Failure("overwrite", "отчёт.txt", "ENOENT")], res.Failures);
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    [Fact]
    public async Task источник_исчез_перед_копированием_это_ошибка_а_не_тихий_пропуск()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        var plan = new SyncPlan { Copy = [new FileEntry("новый.txt", 3, FsOps.ToMs(DateTime.UtcNow))] };

        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());

        Assert.False(Exists(dst.Root, "новый.txt"));
        Assert.Equal([new Failure("copy", "новый.txt", "ENOENT")], res.Failures);
    }

    [Fact]
    public async Task источник_исчез_при_запасном_пути_перемещения_оригинал_не_пропадает()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        dst.Write("было.txt", "данные");
        // Путь назначения занимаем папкой: rename на неё не пройдёт, пойдёт запасной путь.
        dst.Write("стало.txt/внутри.txt", "чужое");

        var gone = new FileEntry("было.txt", 6, 0);
        var added = new FileEntry("стало.txt", 6, 0);
        var plan = new SyncPlan { Moves = [new Move("было.txt", "стало.txt", "стало.txt", 6, gone, added)] };

        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());

        Assert.Equal("данные", Read(dst.Root, "было.txt"));
        var f = Assert.Single(res.Failures);
        Assert.Equal("ENOENT", f.Code);
    }

    [Fact]
    public async Task restoreStage_не_уничтожает_оригиналы_которые_не_смог_вернуть()
    {
        using var dst = new TempDir();
        var stage = FsOps.StageDir;
        dst.Write($"{stage}/вернётся.txt", "первый");
        dst.Write($"{stage}/застрял.txt", "второй");
        // Место возврата занято непустой папкой - rename туда не пройдёт.
        dst.Write("застрял.txt/помеха.txt", "мешает");

        var restored = await FsOps.RestoreStage(dst.Root);

        Assert.Equal(1, restored);
        Assert.Equal("первый", Read(dst.Root, "вернётся.txt"));
        Assert.Equal("второй", Read(dst.Root, $"{stage}/застрял.txt"));
    }

    // ---- Служебная папка: пустые ветки и подсчёт содержимого ----

    [Fact]
    public async Task restoreStage_возвращает_пустые_папки_а_не_только_файлы()
    {
        using var dst = new TempDir();
        dst.Write($"{FsOps.StageDir}/ветка/файл.txt", "данные");
        dst.Mkdir($"{FsOps.StageDir}/ветка/пустая");

        await FsOps.RestoreStage(dst.Root);

        Assert.True(Exists(dst.Root, "ветка/файл.txt"));
        Assert.True(Directory.Exists(dst.P("ветка/пустая")), "пустая папка - тоже содержимое");
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    [Fact]
    public async Task restoreStage_возвращает_ветку_в_которой_нет_ни_одного_файла()
    {
        using var dst = new TempDir();
        dst.Mkdir($"{FsOps.StageDir}/только-папки/глубже");

        await FsOps.RestoreStage(dst.Root);

        Assert.True(Directory.Exists(dst.P("только-папки/глубже")));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    [Fact]
    public async Task restoreStage_сливает_содержимое_когда_место_занято_папкой()
    {
        using var dst = new TempDir();
        dst.Write($"{FsOps.StageDir}/общая/из-служебной.txt", "вернуть");
        dst.Write("общая/на-месте.txt", "уже тут");

        await FsOps.RestoreStage(dst.Root);

        Assert.True(Exists(dst.Root, "общая/из-служебной.txt"));
        Assert.True(Exists(dst.Root, "общая/на-месте.txt"));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    // ---- mkdir не должен уходить на каждый файл ----

    [Fact]
    public async Task копирование_пачки_файлов_в_одну_папку_не_гонит_mkdir_на_каждый()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        for (var i = 0; i < 12; i++) src.Write($"ветка/ф{i}.txt", $"{i}");

        var plan = PlanOf(await Scan(src.Root), []);
        var calls = 0;
        FsOps.MkdirObserver.Value = _ => Interlocked.Increment(ref calls);
        try
        {
            await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());
        }
        finally
        {
            FsOps.MkdirObserver.Value = null;
        }

        Assert.True(calls <= 3, $"mkdir вызван {calls} раз на 12 файлов в одной папке");
        Assert.Equal(12, (await Scan(dst.Root)).Count);
    }

    // ---- Уборка отложенного, когда часть оригиналов застряла ----

    [Fact]
    public async Task Корзина_отказала_оригиналы_остаются_в_служебной_папке_а_не_пропадают()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("общий.txt", "останется");
        foreach (var n in new[] { "a", "b", "c" }) dst.Write($"лишний-{n}.txt", "убрать");
        dst.Write("общий.txt", "останется");

        var plan = PlanOf(await Scan(src.Root), await Scan(dst.Root));
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, (_, _) => throw new FsException("EBUSY", "занято"));

        Assert.Single(res.Failures); // об отказе сообщаем ровно один раз
        Assert.Equal(0, res.Trashed);
        Assert.Equal(3, (await Scan(dst.P(FsOps.StageDir))).Count);
        Assert.True(await FsOps.RestoreStage(dst.Root) > 0, "следующий запуск возвращает их на место");
        Assert.True(Exists(dst.Root, "лишний-a.txt"));
    }

    [Fact]
    public async Task вес_вызова_Корзины_равен_числу_файлов_в_служебной_папке()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        foreach (var n in new[] { "a", "b", "c" }) dst.Write($"лишний-{n}.txt", "убрать");

        var plan = PlanOf(await Scan(src.Root), await Scan(dst.Root));
        int? weight = null;
        await FsOps.ApplyPlan(src.Root, dst.Root, plan, (abs, w) =>
        {
            weight = w;
            FsOps.RmForce(abs);
            return Task.CompletedTask;
        });

        Assert.Equal(3, weight);
    }

    // Конфликт типа уезжает целой папкой, но вес обязан считать её содержимое:
    // занижённый отчёт выглядит спокойным ровно тогда, когда потеряно больше всего.
    [Fact]
    public async Task вес_учитывает_содержимое_папки_снятой_конфликтом_типа()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("ветка/узел", "на источнике это файл");
        for (var i = 0; i < 5; i++) dst.Write($"ветка/узел/ф{i}.txt", "живой файл");

        var plan = await Plan.BuildRunPlan(src.Root, dst.Root, ["ветка"], [], LiveScan);
        Assert.Equal(["ветка/узел"], plan.Conflicts);

        var насчитано = 0;
        await FsOps.ApplyPlan(src.Root, dst.Root, plan, (abs, w) =>
        {
            Interlocked.Add(ref насчитано, w);
            FsOps.RmForce(abs);
            return Task.CompletedTask;
        });

        Assert.Equal(5, насчитано);
    }

    // Обход по файлам не видит узлов с именем служебной папки - считать им содержимое
    // самой служебной папки нельзя: такой файл проходил как пустое место.
    [Fact]
    public async Task оригинал_с_именем_служебной_папки_не_пропадает_при_разборе()
    {
        using var dst = new TempDir();
        dst.Write($"{FsOps.StageDir}/ветка/{FsOps.StageDir}", "у этого файла особое имя");

        await FsOps.RestoreStage(dst.Root);

        Assert.Equal("у этого файла особое имя", Read(dst.Root, $"ветка/{FsOps.StageDir}"));
    }

    [Fact]
    public async Task служебная_папка_уцелеет_пока_внутри_лежит_невозвратимый_оригинал()
    {
        using var dst = new TempDir();
        dst.Write($"ветка/{FsOps.StageDir}/помеха.txt", "занимает место");
        dst.Write($"{FsOps.StageDir}/ветка/{FsOps.StageDir}", "единственная копия");

        await FsOps.RestoreStage(dst.Root);

        Assert.Equal("единственная копия", Read(dst.Root, $"{FsOps.StageDir}/ветка/{FsOps.StageDir}"));
    }

    // Возврат идёт целыми узлами, поэтому оригинал встаёт на место даже тогда, когда
    // его позицию занял оборвавшийся запуск (папка поверх файла - как rename в Node).
    [Fact]
    public async Task оригинал_возвращается_поверх_того_что_занял_его_место()
    {
        using var dst = new TempDir();
        dst.Write("занято", "помеха от оборванного запуска");
        dst.Write($"{FsOps.StageDir}/занято/внутри.txt", "единственная копия");

        await FsOps.RestoreStage(dst.Root);

        Assert.Equal("единственная копия", Read(dst.Root, "занято/внутри.txt"));
        Assert.False(Exists(dst.Root, FsOps.StageDir));
    }

    // Нового в C#: правила rename те же, что у Node на Windows (проверено пробой).
    [Fact]
    public void rename_как_в_Node_файл_поверх_файла_и_папка_поверх_файла_заменяют()
    {
        using var t = new TempDir();
        t.Write("a", "A");
        t.Write("b", "B");
        FsOps.Rename(t.P("a"), t.P("b"));
        Assert.Equal("A", Read(t.Root, "b"));

        t.Mkdir("D");
        t.Write("c", "C");
        Assert.Equal("EPERM", Assert.Throws<FsException>(() => FsOps.Rename(t.P("c"), t.P("D"))).Code);

        t.Mkdir("E");
        t.Mkdir("F");
        Assert.Equal("EPERM", Assert.Throws<FsException>(() => FsOps.Rename(t.P("E"), t.P("F"))).Code);

        t.Mkdir("G");
        t.Write("h", "H");
        FsOps.Rename(t.P("G"), t.P("h"));
        Assert.True(Directory.Exists(t.P("h")));
    }
}
