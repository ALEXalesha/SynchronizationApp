using SyncGlass.Core;

namespace SyncGlass.Tests;

// Перенос test/racing.test.js. Живая папка меняется под руками у обхода: временные
// файлы, кеш браузера, сборка. В JS гонка сидела между readdir и stat по файлу;
// в C# размер и дата приходят вместе со списком папки, и этой щели нет вовсе -
// тесты «файл исчез перед stat» и «прав на файл не дали» тут неприменимы (см.
// комментарий у FsOps.ReadDir). Осталась щель на уровне папок: подпапку показал
// список родителя, а к её собственному чтению её уже нет. Её и держат тесты ниже.
public class RacingTests
{
    private static TempDir TreeWithFive()
    {
        var t = new TempDir();
        for (var i = 0; i < 5; i++) t.Write($"sub/f{i}.txt", "x");
        t.Write("gone/g.txt", "g");
        return t;
    }

    // Подменяет чтение одной папки ошибкой на время теста.
    private static IDisposable BreakReadDirFor(string suffix, Exception err)
    {
        FsOps.ReadDirFault.Value = p => p.Replace('\\', '/').EndsWith(suffix, StringComparison.Ordinal) ? err : null;
        return new Restore();
    }

    private sealed class Restore : IDisposable
    {
        public void Dispose() => FsOps.ReadDirFault.Value = null;
    }

    [Fact]
    public async Task подпапка_исчезла_между_списком_родителя_и_своим_чтением_скан_продолжается_без_неё()
    {
        using var root = TreeWithFive();
        using var _ = BreakReadDirFor("/gone", new DirectoryNotFoundException("gone"));

        var skipped = new List<string>();
        var files = await FsOps.ScanFiles(root.Root, "", null, null, null, [], skipped);

        Assert.Equal(["sub/f0.txt", "sub/f1.txt", "sub/f2.txt", "sub/f3.txt", "sub/f4.txt"],
                     files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal));
        // Папки действительно нет - это не «не дали посмотреть», а честное отсутствие.
        Assert.Empty(skipped);
    }

    [Fact]
    public async Task подпапка_исчезла_посреди_подсчёта_размеров_обход_досчитывается()
    {
        using var root = TreeWithFive();
        using var _ = BreakReadDirFor("/gone", new DirectoryNotFoundException("gone"));

        var seen = new List<string>();
        var total = await FsOps.CrawlTree(root.Root, "", (rel, isDir, _, _, _) =>
        {
            if (!isDir) lock (seen) seen.Add(rel);
        }, []);

        Assert.Equal(5, seen.Count);
        Assert.Equal(5, total.Count);
    }

    // Кончились дескрипторы, оборвалась сеть - принять это за «папки нет» значило бы
    // строить план по неполным данным и стереть с приёмника живую ветку.
    [Fact]
    public async Task прочие_сбои_чтения_папки_по_прежнему_обрывают_обход()
    {
        using var root = TreeWithFive();
        using var _ = BreakReadDirFor("/sub", new FsException("EMFILE", "too many open files"));

        var e1 = await Assert.ThrowsAsync<FsException>(() => FsOps.ScanFiles(root.Root, "", null, null, null, [], []));
        Assert.Equal("EMFILE", e1.Code);
        var e2 = await Assert.ThrowsAsync<FsException>(() => FsOps.CrawlTree(root.Root, "", (_, _, _, _, _) => { }, []));
        Assert.Equal("EMFILE", e2.Code);
    }

    // onFile бросает, когда предпросмотр отменили: отмена не должна утонуть.
    [Fact]
    public async Task отмена_предпросмотра_пробивается_сквозь_обработку_ошибок()
    {
        using var root = TreeWithFive();
        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            FsOps.ScanFiles(root.Root, "", null, null, () => throw new OperationCanceledException(), [], []));
    }

    [Fact]
    public async Task listChildren_отличает_пустую_папку_от_нечитаемой()
    {
        using var root = new TempDir();
        root.Mkdir("пусто");
        root.Write("есть/a.txt", "a");

        var empty = await FsOps.ListChildren(root.P("пусто"));
        Assert.Empty(empty.Items);
        Assert.True(empty.Ok, "пустая папка прочитана успешно");

        var missing = await FsOps.ListChildren(root.P("нет-такой"));
        Assert.Empty(missing.Items);
        Assert.False(missing.Ok, "папки нет - список ничего не значит");

        var full = await FsOps.ListChildren(root.Root);
        Assert.True(full.Ok);
        Assert.Equal(["есть", "пусто"], full.Items.Select(c => c.Name).OrderBy(n => n, StringComparer.Ordinal));
    }
}
