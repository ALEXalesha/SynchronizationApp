namespace SyncGlass.Core;

// Запись списка папки: имя, тип и то, что система отдаёт вместе со списком.
public sealed record Dirent(string Name, bool IsDir, bool IsFile, bool IsSymlink, long Size, double MtimeMs);

public sealed record ChildItem(string Name, bool IsDir, double MtimeMs);

// Узел обхода: папка, её незаконченное (своё чтение плюс по единице на каждую подпапку)
// и накопленные размеры.
public sealed class WalkNode
{
    public string Rel { get; }
    public WalkNode? Parent { get; }
    internal int Pending = 1;
    internal long SizeAcc;
    internal int CountAcc;
    public long Size => Interlocked.Read(ref SizeAcc);
    public int Count => Volatile.Read(ref CountAcc);

    public WalkNode(string rel, WalkNode? parent)
    {
        Rel = rel;
        Parent = parent;
    }

    public void Add(long size, int count)
    {
        Interlocked.Add(ref SizeAcc, size);
        Interlocked.Add(ref CountAcc, count);
    }
}

public enum ChildKind { Skip, Dir, File }

// Обработчики обхода (h в walkTree из JS).
internal interface IWalk
{
    // Список папки или null - папку пропустить (её нет или она закрыта).
    List<Dirent>? ReadDir(string rel);
    ChildKind Child(WalkNode node, Dirent d, string childRel);
    void File(WalkNode node, Dirent d, string childRel);
    void DirDone(WalkNode node);
}

public static partial class FsOps
{
    // Подмена для тестов: по пути папки - исключение, которым ответит её чтение (null -
    // читать как обычно). AsyncLocal, как StatOverride.
    internal static readonly AsyncLocal<Func<string, Exception?>?> ReadDirFault = new();

    // Держим всё, включая скрытые и системные: Node их видит, и план обязан их видеть.
    private static readonly EnumerationOptions ListAll = new()
    {
        AttributesToSkip = 0,
        IgnoreInaccessible = false,
        RecurseSubdirectories = false,
        ReturnSpecialDirectories = false,
    };

    // Список папки. Размер и дата файла приходят вместе со списком - так их видит
    // и Проводник; Node на каждый файл делает отдельный stat, а по сети это круг
    // до шары на файл. Отличие одно: закрытый правами файл в открытой папке Node
    // пропускал как «размер неизвестен», а здесь он виден с размером - удалить
    // его копию на другой стороне это не может (он есть в списке), а не удастся
    // скопировать - будет ошибкой в отчёте. Ссылки и точки соединения - IsSymlink.
    internal static List<Dirent> ReadDir(string dir)
    {
        // Сбой чтения, подставленный тестом (гонки и обрывы не воспроизводятся иначе).
        DiskObserver.Value?.Invoke(dir);
        if (ReadDirFault.Value?.Invoke(dir) is { } fault) throw fault;
        var outList = new List<Dirent>();
        foreach (var fi in new DirectoryInfo(dir).EnumerateFileSystemInfos("*", ListAll))
        {
            var attrs = fi.Attributes;
            var isDir = attrs.HasFlag(FileAttributes.Directory);
            // Спрашивать цель ссылки дорого (открытие узла), поэтому только у точек повторного
            // разбора. Облачные заглушки OneDrive - тоже точки разбора, но не ссылки.
            var isLink = attrs.HasFlag(FileAttributes.ReparsePoint) && fi.LinkTarget != null;
            var size = !isDir && fi is FileInfo f ? f.Length : 0;
            outList.Add(new Dirent(fi.Name, isDir, !isDir, isLink, size, ToMs(fi.LastWriteTimeUtc)));
        }
        return outList;
    }

    // Обход дерева фиксированным числом работников (walkTree в JS). Работник берёт со
    // стека папку, читает её список и кладёт на стек подпапки; файлы учитываются сразу,
    // из списка, - задачи на каждый файл нет (закон памяти, test/memory.test.js).
    // Папка отчитывается (DirDone) после всего своего содержимого. Первая ошибка
    // останавливает работников: новые папки никто не берёт, начатые доделываются,
    // и обход отказывает этой ошибкой.
    internal static async Task<WalkNode> WalkTree(string rootRel, IWalk h, int concurrency = ScanConcurrency)
    {
        var root = new WalkNode(rootRel, null);
        var stack = new Stack<WalkNode>();
        stack.Push(root);
        var gate = new object();
        var idle = new List<TaskCompletionSource>();
        var active = 0;
        Exception? failure = null;
        var done = false;

        void WakeAll()
        {
            List<TaskCompletionSource> waiting;
            lock (gate)
            {
                waiting = new List<TaskCompletionSource>(idle);
                idle.Clear();
            }
            foreach (var w in waiting) w.TrySetResult();
        }

        void Finish(WalkNode node)
        {
            // Папка закончена - отчитаться и подняться к родителю, пока родитель тоже
            // не ждёт больше ничего.
            for (var n = node; n != null; n = n.Parent)
            {
                if (Interlocked.Decrement(ref n.Pending) > 0) return;
                h.DirDone(n);
                n.Parent?.Add(n.Size, n.Count);
            }
        }

        void Take(WalkNode node)
        {
            var dirents = h.ReadDir(node.Rel);
            if (dirents != null)
            {
                var sub = new List<WalkNode>();
                foreach (var d in dirents)
                {
                    var childRel = node.Rel != "" ? $"{node.Rel}/{d.Name}" : d.Name;
                    switch (h.Child(node, d, childRel))
                    {
                        case ChildKind.Dir:
                            Interlocked.Increment(ref node.Pending);
                            sub.Add(new WalkNode(childRel, node));
                            break;
                        case ChildKind.File:
                            h.File(node, d, childRel);
                            break;
                    }
                }
                if (sub.Count > 0)
                {
                    lock (gate) foreach (var s in sub) stack.Push(s);
                    WakeAll();
                }
            }
            Finish(node);
        }

        async Task Worker()
        {
            for (;;)
            {
                WalkNode? item = null;
                TaskCompletionSource? wait = null;
                var finished = false;
                lock (gate)
                {
                    if (failure != null || done) return;
                    if (stack.Count > 0)
                    {
                        item = stack.Pop();
                        active++;
                    }
                    else if (active == 0)
                    {
                        done = true;
                        finished = true;
                    }
                    else
                    {
                        wait = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                        idle.Add(wait);
                    }
                }
                if (finished)
                {
                    WakeAll();
                    return;
                }
                if (wait != null)
                {
                    await wait.Task;
                    continue;
                }
                try
                {
                    Take(item!);
                }
                catch (Exception e)
                {
                    lock (gate) failure ??= e;
                    WakeAll();
                }
                finally
                {
                    bool wake;
                    lock (gate)
                    {
                        active--;
                        wake = active == 0 && stack.Count == 0;
                    }
                    if (wake) WakeAll();
                }
            }
        }

        var workers = new Task[concurrency];
        for (var i = 0; i < concurrency; i++) workers[i] = Task.Run(Worker);
        await Task.WhenAll(workers);
        if (failure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(failure);
        return root;
    }

    // Список папки для обхода: нет папки - пропустить; закрыта правами - в skippedOut
    // и пропустить; любой другой сбой (оборвалась сеть) обрывает обход: строить план
    // по неполным данным опаснее, чем не строить.
    private static List<Dirent>? ReadDirForWalk(string abs, string rel, List<string>? skippedOut)
    {
        try
        {
            return ReadDir(abs);
        }
        catch (Exception e) when (IsGone(e))
        {
            return null;
        }
        catch (Exception e) when (IsDenied(e) && skippedOut != null)
        {
            lock (skippedOut) skippedOut.Add(rel);
            return null;
        }
    }

    private sealed class ScanWalk(string dir, List<FileEntry> outList, HashSet<string>? excludes, Action? onFile,
                                  List<string>? dirsOut, List<string>? skippedOut) : IWalk
    {
        public List<Dirent>? ReadDir(string rel) => ReadDirForWalk(Path.Join(dir, rel), rel, skippedOut);

        public ChildKind Child(WalkNode node, Dirent d, string childRel)
        {
            if (excludes != null && excludes.Contains(Paths.CiKey(childRel))) return ChildKind.Skip; // исключённая ветка
            if (d.IsSymlink) return ChildKind.Skip;
            if (d.Name == StageDir) return ChildKind.Skip;
            if (d.IsDir)
            {
                if (dirsOut != null) lock (dirsOut) dirsOut.Add(childRel);
                return ChildKind.Dir;
            }
            return d.IsFile ? ChildKind.File : ChildKind.Skip;
        }

        public void File(WalkNode node, Dirent d, string childRel)
        {
            lock (outList) outList.Add(new FileEntry(childRel, d.Size, d.MtimeMs));
            // onFile бросает при отмене предпросмотра - и отмена обязана дойти до вызывающего.
            onFile?.Invoke();
        }

        public void DirDone(WalkNode node) { }
    }

    // Рекурсивно собирает список файлов внутри dir: пути относительные, разделитель '/'.
    // Ссылки не обходятся. excludes - пути папок (относительно dir), пропускаемые
    // целиком; без регистра, потому что ветка могла прийти с той стороны, что пишет
    // имя иначе. dirsOut - пути папок. skippedOut - закрытое правами: пустым списком
    // его содержимое подменить нельзя (пустой источник - «на приёмнике всё лишнее»),
    // поэтому оно уходит наверх, и план выбрасывает его на обеих сторонах разом.
    public static async Task<List<FileEntry>> ScanFiles(string dir, string rel = "", List<FileEntry>? outList = null,
        IEnumerable<string>? excludes = null, Action? onFile = null, List<string>? dirsOut = null, List<string>? skippedOut = null)
    {
        outList ??= new List<FileEntry>();
        var skip = excludes != null ? new HashSet<string>(excludes.Select(Paths.CiKey), StringComparer.Ordinal) : null;
        await WalkTree(rel, new ScanWalk(dir, outList, skip, onFile, dirsOut, skippedOut));
        return outList;
    }

    // Прямые дети папки: и подпапки, и файлы (без рекурсии). Ok=false - прочитать папку
    // не удалось (нет её, нет прав, оборвалась сеть): без этого флага пустой список
    // значил бы сразу и «папка пуста», и «прочитать не вышло», и интерфейс стирал бы
    // отметки выбранных папок. Дата приходит вместе со списком, отдельного прохода
    // для сортировки по дате не нужно; withMtime=false отдаёт 0, как в JS.
    public static Task<(List<ChildItem> Items, bool Ok)> ListChildren(string dir, bool withMtime = false)
    {
        List<Dirent> dirents;
        try
        {
            dirents = ReadDir(dir);
        }
        catch
        {
            // Отвалившаяся сторона не должна рушить весь листинг.
            return Task.FromResult((new List<ChildItem>(), false));
        }
        var items = dirents
            .Where(d => !d.IsSymlink && d.Name != StageDir && (d.IsDir || d.IsFile))
            .Select(d => new ChildItem(d.Name, d.IsDir, withMtime ? d.MtimeMs : 0))
            .ToList();
        return Task.FromResult((items, true));
    }

    public delegate void CrawlEntry(string rel, bool isDir, long size, int count, double? mtimeMs);

    private sealed class CrawlWalk(string root, CrawlEntry onEntry, List<string>? skippedOut) : IWalk
    {
        public List<Dirent>? ReadDir(string rel) => ReadDirForWalk(Path.Join(root, rel), rel, skippedOut);

        public ChildKind Child(WalkNode node, Dirent d, string childRel)
        {
            if (d.IsSymlink || d.Name == StageDir) return ChildKind.Skip;
            if (d.IsDir) return ChildKind.Dir;
            return d.IsFile ? ChildKind.File : ChildKind.Skip;
        }

        public void File(WalkNode node, Dirent d, string childRel)
        {
            // onEntry бросает при отмене и на пределе обхода - и погасить обход обязан.
            onEntry(childRel, false, d.Size, 1, d.MtimeMs);
            node.Add(d.Size, 1);
        }

        // Корень обхода не отчитывается: его итог - то, что возвращаем.
        public void DirDone(WalkNode node)
        {
            if (node.Parent != null) onEntry(node.Rel, true, node.Size, node.Count, null);
        }
    }

    // Полный обход для подсчёта размеров: onEntry на каждый файл (размер, 1) и на каждую
    // папку (суммы по вложенному). skippedOut - закрытые правами папки.
    public static async Task<(long Size, int Count)> CrawlTree(string root, string rel, CrawlEntry onEntry, List<string>? skippedOut = null)
    {
        var top = await WalkTree(rel, new CrawlWalk(root, onEntry, skippedOut));
        return (top.Size, top.Count);
    }
}
