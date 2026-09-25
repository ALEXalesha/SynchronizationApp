using SyncGlass.Core;

namespace SyncGlass.Tests;

// Помощники тестов, общие для FsOps, Plan и законов - те же, что в JS-тестах.
internal static class TestUtil
{
    // Дерево папки: файлы как 'a/b.txt', папки как 'a/'. Сортировка по кодам UTF-16,
    // как Array.sort в JS.
    public static List<string> TreeOf(string dir)
    {
        var outList = new List<string>();
        void Walk(string rel)
        {
            IEnumerable<FileSystemInfo> items;
            try
            {
                items = new DirectoryInfo(Path.Join(dir, rel)).EnumerateFileSystemInfos("*", new EnumerationOptions { AttributesToSkip = 0 }).ToList();
            }
            catch
            {
                return;
            }
            foreach (var d in items)
            {
                var r = rel != "" ? $"{rel}/{d.Name}" : d.Name;
                var isDir = d.Attributes.HasFlag(FileAttributes.Directory);
                outList.Add(isDir ? r + "/" : r);
                if (isDir) Walk(r);
            }
        }
        Walk("");
        outList.Sort(StringComparer.Ordinal);
        return outList;
    }

    // Заглушка Корзины: applyPlan отдаёт сюда служебную папку целиком.
    public static TrashFn MockTrash(List<string>? collected = null) => (abs, _) =>
    {
        if (collected != null) lock (collected) collected.Add(abs);
        FsOps.RmForce(abs);
        return Task.CompletedTask;
    };

    // Исключения ветки относительно неё самой (branchExcludes в JS-тестах плана).
    private static List<string> BranchExcludes(IEnumerable<string> excludes, string folder)
        => excludes.Where(ex => ex.StartsWith(folder + "/", StringComparison.Ordinal)).Select(ex => ex[(folder.Length + 1)..]).ToList();

    // Живой сканер - такой же, каким main.js кормит планировщик, но без кеша и обхода.
    public static readonly Scanner LiveScan = async (root, branch, excludes) =>
    {
        var dirs = new List<string>();
        var skipped = new List<string>();
        var files = await FsOps.ScanFiles(Path.Join(root, branch), "", null, BranchExcludes(excludes, branch), null, dirs, skipped);
        return new ScanResult(files, dirs, skipped);
    };

    // Скан всей папки без исключений (scanFiles(dir) в JS).
    public static Task<List<FileEntry>> Scan(string dir, List<string>? dirsOut = null) => FsOps.ScanFiles(dir, "", null, null, null, dirsOut);

    // Копия дерева с датами (fsp.cp recursive).
    public static void CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var d in Directory.EnumerateDirectories(from, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Join(to, Path.GetRelativePath(from, d)));
        foreach (var f in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            var dst = Path.Join(to, Path.GetRelativePath(from, f));
            File.Copy(f, dst, true);
        }
    }

    public static string Read(string root, string rel) => File.ReadAllText(Path.Join(root, rel));

    public static bool Exists(string root, string rel) => File.Exists(Path.Join(root, rel)) || Directory.Exists(Path.Join(root, rel));

    public static void SetMtime(string root, string rel, DateTime utc) => File.SetLastWriteTimeUtc(Path.Join(root, rel), utc);
}
