using System.Diagnostics;
using SyncGlass.Core;
using static SyncGlass.Tests.TestUtil;

namespace SyncGlass.Tests;

// Перенос test/denied.test.js: папки, закрытые правами (настоящий icacls). Одна такая
// папка обрывала весь обход, а подменить её содержимое пустым списком нельзя - пустой
// источник означает «на приёмнике всё лишнее», - поэтому ветка выбывает из плана на
// обеих сторонах. Тест про list-folders - в BackendTests.
public class DeniedTests
{
    // Закрывает папку от текущего пользователя; Dispose возвращает доступ, иначе
    // каталог не удалить даже уборкой после теста.
    internal sealed class Deny : IDisposable
    {
        private readonly string _dir;

        public Deny(string dir)
        {
            _dir = dir;
            Icacls(dir, "/inheritance:r", "/deny", $"{Environment.UserName}:(OI)(CI)(RX)");
        }

        public void Dispose() => Icacls(_dir, "/grant", $"{Environment.UserName}:(OI)(CI)F");

        private static void Icacls(params string[] args)
        {
            var psi = new ProcessStartInfo("icacls") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            p.WaitForExit();
            if (p.ExitCode != 0) throw new InvalidOperationException("icacls: " + p.StandardError.ReadToEnd());
        }
    }

    // Сканер с исключениями ветки - как в denied.test.js.
    private static readonly Scanner Scanner = async (root, branch, excludes) =>
    {
        var prefix = branch != "" ? branch + "/" : "";
        var set = new List<string>();
        foreach (var ex in excludes)
        {
            if (prefix != "" && ex.Length > prefix.Length && Paths.CiKey(ex[..prefix.Length]) == Paths.CiKey(prefix)) set.Add(ex[prefix.Length..]);
            else if (prefix == "") set.Add(ex);
        }
        var dirs = new List<string>();
        var skipped = new List<string>();
        var files = await FsOps.ScanFiles(Path.Join(root, branch), "", null, set, null, dirs, skipped);
        return new ScanResult(files, dirs, skipped);
    };

    [Fact]
    public async Task закрытая_правами_папка_не_обрывает_обход_а_возвращается_отдельным_списком()
    {
        using var root = new TempDir();
        root.Write("ok/a.txt", "a");
        root.Write("locked/secret.txt", "s");
        using var deny = new Deny(root.P("locked"));

        var dirs = new List<string>();
        var skipped = new List<string>();
        var files = await FsOps.ScanFiles(root.Root, "", null, null, null, dirs, skipped);

        Assert.Equal(["ok/a.txt"], files.Select(f => f.Path));
        Assert.Equal(["locked"], skipped);
        // Сама папка остаётся в структуре: она существует, просто внутрь не пускают.
        Assert.Contains("locked", dirs);
    }

    // Без skippedOut закрытая папка - не молчаливая пустота, а ошибка обхода.
    [Fact]
    public async Task без_списка_закрытых_закрытая_папка_обрывает_обход()
    {
        using var root = new TempDir();
        root.Write("locked/secret.txt", "s");
        using var deny = new Deny(root.P("locked"));

        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => FsOps.ScanFiles(root.Root));
    }

    [Fact]
    public async Task обход_размеров_переживает_закрытую_папку_и_называет_её()
    {
        using var root = new TempDir();
        root.Write("ok/a.txt", "aaa");
        root.Write("locked/secret.txt", "s");
        using var deny = new Deny(root.P("locked"));

        var skipped = new List<string>();
        var seen = new List<string>();
        var agg = await FsOps.CrawlTree(root.Root, "", (rel, _, _, _, _) => { lock (seen) seen.Add(rel); }, skipped);

        Assert.Equal(["locked"], skipped);
        Assert.Equal(1, agg.Count);
        Assert.Contains("ok/a.txt", seen);
    }

    // Главный случай: на источнике папка закрыта, на приёмнике её копия видна целиком.
    [Fact]
    public async Task содержимое_закрытой_папки_не_удаляется_с_приёмника()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("data/keep.txt", "k");
        src.Write("data/locked/inside.txt", "i");
        dst.Write("data/keep.txt", "k");
        dst.Write("data/locked/inside.txt", "i");
        dst.Write("data/locked/extra.txt", "e");
        using var deny = new Deny(src.P("data/locked"));

        var plan = await Plan.BuildRunPlan(src.Root, dst.Root, ["data"], [], Scanner);

        Assert.Empty(plan.Trash);
        Assert.Empty(plan.Dirs.Remove);
        Assert.Equal(["data/locked"], plan.Skipped);

        await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());

        Assert.Equal("e", Read(dst.Root, "data/locked/extra.txt"));
        Assert.Equal("i", Read(dst.Root, "data/locked/inside.txt"));
    }

    // Заглянуть в приёмник не дают - сравнивать нечего, копировать наугад нельзя.
    [Fact]
    public async Task закрытая_папка_на_приёмнике_не_наполняется_вслепую_с_источника()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("data/locked/inside.txt", "i");
        src.Write("data/open.txt", "o");
        dst.Write("data/locked/inside.txt", "i");
        using var deny = new Deny(dst.P("data/locked"));

        var plan = await Plan.BuildRunPlan(src.Root, dst.Root, ["data"], [], Scanner);

        Assert.Equal(["data/open.txt"], plan.Copy.Select(e => e.Path));
        Assert.Equal(["data/locked"], plan.Skipped);
    }

    // Один и тот же выбор - один и тот же план, включён ли подсчёт размеров или нет.
    [Fact]
    public async Task индекс_обхода_обходит_закрытую_папку_так_же_как_живой_скан()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("data/keep.txt", "k");
        src.Write("data/locked/inside.txt", "i");
        dst.Write("data/keep.txt", "k");
        dst.Write("data/locked/inside.txt", "i");
        dst.Write("data/locked/extra.txt", "e");
        using var deny = new Deny(src.P("data/locked"));

        async Task<CrawlSide> IndexOf(string root)
        {
            var files = new Dictionary<string, (long, double)>(StringComparer.Ordinal);
            var dirs = new HashSet<string>(StringComparer.Ordinal);
            var skipped = new List<string>();
            await FsOps.CrawlTree(root, "", (rel, isFolder, size, _, mtime) =>
            {
                lock (files)
                {
                    if (isFolder) dirs.Add(rel);
                    else files[rel] = (size, mtime ?? 0);
                }
            }, skipped);
            return new CrawlSide(files, dirs, skipped);
        }
        var idx = new Dictionary<string, CrawlSide> { [src.Root] = await IndexOf(src.Root), [dst.Root] = await IndexOf(dst.Root) };
        Scanner byIndex = (root, branch, excludes) => Task.FromResult(Plan.ScanFromIndex(idx[root], branch, excludes));

        var live = await Plan.BuildRunPlan(src.Root, dst.Root, ["data"], [], Scanner);
        var indexed = await Plan.BuildRunPlan(src.Root, dst.Root, ["data"], [], byIndex);

        static string Shape(SyncPlan p) => string.Join("|",
            string.Join(",", p.Copy.Select(e => e.Path).OrderBy(x => x, StringComparer.Ordinal)),
            string.Join(",", p.Trash.Select(e => e.Path).OrderBy(x => x, StringComparer.Ordinal)),
            string.Join(",", p.Dirs.Remove.OrderBy(x => x, StringComparer.Ordinal)),
            string.Join(",", p.Skipped.OrderBy(x => x, StringComparer.Ordinal)));
        Assert.Equal(Shape(live), Shape(indexed));
        Assert.Equal(["data/locked"], indexed.Skipped);
    }

    [Fact]
    public async Task закрыт_сам_корень_выбранной_ветки_ветка_выбывает_целиком()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("locked/inside.txt", "i");
        dst.Write("locked/other.txt", "o");
        using var deny = new Deny(src.P("locked"));

        var plan = await Plan.BuildRunPlan(src.Root, dst.Root, ["locked"], [], Scanner);

        Assert.Empty(plan.Trash);
        Assert.Empty(plan.Copy);
        Assert.Equal(["locked"], plan.Skipped);
    }
}
