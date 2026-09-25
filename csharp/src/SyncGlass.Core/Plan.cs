using System.Collections.Concurrent;

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

public enum NodeType { Dir, File, Missing }

// План одной ветки до слияния (planForBranch в JS).
public sealed record BranchPlan(SyncPlan Plan, List<string> SrcDirs, List<string> DstDirs, List<string> Conflicts, List<string> Skipped);

/// <summary>
/// Перенос src/plan.js: план запуска из выбранных веток. Полные объяснения «почему»
/// (все они - про найденные баги и замеры) - в комментариях src/plan.js.
/// </summary>
public static class Plan
{
    // Тип узла на стороне root. memo - общая на весь запуск памятка «сторона и путь →
    // тип»: без неё цепочка родителей у каждой ветки читалась заново и строго по очереди -
    // на шаре около минуты тишины между сканом и предпросмотром. Ключ без регистра:
    // 'Док' и 'док' - один узел, второй раз спрашивать диск не о чем.
    public static Task<NodeType> StatType(string root, string rel, ConcurrentDictionary<string, Lazy<Task<NodeType>>>? memo)
    {
        if (memo == null) return ReadType(root, rel);
        var key = root + "\0" + Paths.CiKey(rel);
        return memo.GetOrAdd(key, _ => new Lazy<Task<NodeType>>(() => ReadType(root, rel))).Value;
    }

    private static async Task<NodeType> ReadType(string root, string rel)
    {
        var attrs = await FsOps.StatAttributes(Path.Join(root, rel));
        if (attrs is not { } a) return NodeType.Missing;
        return a.HasFlag(FileAttributes.Directory) ? NodeType.Dir : NodeType.File;
    }

    private static Task<FileEntry?> StatEntry(string root, string rel)
    {
        var fi = new FileInfo(Path.Join(root, rel));
        if (!fi.Exists) return Task.FromResult<FileEntry?>(null); // нет файла или это папка
        return Task.FromResult<FileEntry?>(new FileEntry(rel, fi.Length, FsOps.ToMs(fi.LastWriteTimeUtc)));
    }

    // Цепочка родителей ветки: 'a/b/c' → ['a', 'a/b'].
    public static List<string> AncestorsOf(string branch)
    {
        var parts = branch.Split('/');
        var outList = new List<string>();
        for (var i = 1; i < parts.Length; i++) outList.Add(string.Join('/', parts, 0, i));
        return outList;
    }

    private static Task<NodeType[]> TypesOf(string root, List<string> rels, ConcurrentDictionary<string, Lazy<Task<NodeType>>>? memo)
        => Task.WhenAll(rels.Select(rel => StatType(root, rel, memo)));

    // Читает типы всех веток и их родителей на обеих сторонах разом (пулом - обращения
    // независимы, а по одному стоят полного круга до шары каждое) и складывает в памятку.
    private static async Task<ConcurrentDictionary<string, Lazy<Task<NodeType>>>> PrefetchTypes(string srcRoot, string dstRoot, IReadOnlyList<string> folders)
    {
        var memo = new ConcurrentDictionary<string, Lazy<Task<NodeType>>>(StringComparer.Ordinal);
        var items = new List<(string Root, string Rel)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var folder in folders)
        {
            var rels = folder != "" ? new List<string> { folder }.Concat(AncestorsOf(folder)) : new[] { "" };
            foreach (var rel in rels)
            {
                foreach (var root in new[] { srcRoot, dstRoot })
                {
                    if (seen.Add(root + "\0" + Paths.CiKey(rel))) items.Add((root, rel));
                }
            }
        }
        await FsOps.RunPool(items, FsOps.ApplyConcurrency, item => StatType(item.Root, item.Rel, memo));
        return memo;
    }

    // План для одной выбранной ветки (папки ИЛИ отдельного файла). Все пути в результате -
    // от корня стороны, а не от ветки: только так виден перенос между выбранными ветками.
    public static async Task<BranchPlan> PlanForBranch(string srcRoot, string dstRoot, string branch,
        IReadOnlyCollection<string> excludes, Scanner scan, ConcurrentDictionary<string, Lazy<Task<NodeType>>>? types = null)
    {
        // Родителей проверяем на каждой стороне отдельно: ветки может не быть на источнике,
        // а её родитель там есть - удалять его на приёмнике нельзя.
        var parents = branch != "" ? AncestorsOf(branch) : new List<string>();
        var srcTypeT = StatType(srcRoot, branch, types);
        var dstTypeT = StatType(dstRoot, branch, types);
        var srcParentT = TypesOf(srcRoot, parents, types);
        var dstParentT = TypesOf(dstRoot, parents, types);
        await Task.WhenAll(srcTypeT, dstTypeT, srcParentT, dstParentT);
        var (srcType, dstType, srcParentTypes, dstParentTypes) = (srcTypeT.Result, dstTypeT.Result, srcParentT.Result, dstParentT.Result);
        var srcParents = parents.Where((_, i) => srcParentTypes[i] == NodeType.Dir).ToList();
        var dstParents = parents.Where((_, i) => dstParentTypes[i] == NodeType.Dir).ToList();

        // Предок ветки: на источнике папка, на приёмнике файл - внутрь не проходит ничего,
        // убираем его фазой конфликтов.
        var conflicts = parents.Where((_, i) => srcParentTypes[i] == NodeType.Dir && dstParentTypes[i] == NodeType.File).ToList();

        // Тот же конфликт на самой ветке.
        if (branch != "" && srcType != NodeType.Missing && dstType != NodeType.Missing && srcType != dstType)
            conflicts.Add(branch);

        if (srcType == NodeType.File || (srcType == NodeType.Missing && dstType == NodeType.File))
        {
            // StatEntry отдаёт null для папки - при конфликте приёмник считается пустым.
            var srcE = await StatEntry(srcRoot, branch);
            var dstE = await StatEntry(dstRoot, branch);
            return new BranchPlan(
                Sync.PlanSync(srcE != null ? [srcE] : [], dstE != null ? [dstE] : []),
                srcParents, dstParents, conflicts, new List<string>());
        }

        // Сторону, которая не папка, не сканируем: чтение папки по файлу обрывало
        // предпросмотр целиком.
        var srcScanT = srcType == NodeType.Dir ? scan(srcRoot, branch, excludes) : Task.FromResult(ScanResult.Empty());
        var dstScanT = dstType == NodeType.Dir ? scan(dstRoot, branch, excludes) : Task.FromResult(ScanResult.Empty());
        var src = await srcScanT;
        var dst = await dstScanT;
        string Under(string rel) => branch != "" ? $"{branch}/{rel}" : rel;
        // Корень ветки скан отдаёт пустой строкой - путём от корня она и есть ветка.
        string UnderPath(string rel) => rel == "" ? branch : Under(rel);
        List<FileEntry> Rebase(IEnumerable<FileEntry> entries) => entries.Select(e => e with { Path = Under(e.Path) }).ToList();

        // Закрытые правами узлы (хотя бы на одной стороне) выбывают из сравнения на ОБЕИХ
        // сторонах разом: закрытая ветка источника, прочитанная пустой, стирала бы живую
        // ветку приёмника. Сам названный путь тоже вне сравнения - закрытым бывает и файл.
        var skipped = TopPaths(src.Skipped.Concat(dst.Skipped));
        var blind = UnderAny(skipped);
        ScanResult Seen(ScanResult side) => skipped.Count > 0
            ? new ScanResult(side.Files.Where(e => !blind(e.Path)).ToList(), side.Dirs.Where(d => !blind(d)).ToList(), side.Skipped)
            : side;
        var srcSeen = Seen(src);
        var dstSeen = Seen(dst);

        // Конфликт типов в глубине ветки: приёмник расчищается одним действием, поэтому
        // всё, что лежало внутри такого узла, из плана вычёркиваем.
        var inner = FindTypeConflicts(srcSeen, dstSeen);
        var covered = UnderAny(inner);
        var dstFiles = inner.Count > 0 ? dstSeen.Files.Where(e => !covered(e.Path)).ToList() : dstSeen.Files;
        var dstDirs = inner.Count > 0 ? dstSeen.Dirs.Where(d => !covered(d)).ToList() : dstSeen.Dirs;
        conflicts.AddRange(inner.Select(Under));

        // Сама ветка - часть структуры: без неё пустая выбранная папка не создастся.
        var self = branch != "" ? new List<string> { branch } : new List<string>();
        var srcDirs = new List<string>(srcParents);
        if (srcType == NodeType.Dir) { srcDirs.AddRange(self); srcDirs.AddRange(srcSeen.Dirs.Select(Under)); }
        var dstDirsAll = new List<string>(dstParents);
        if (dstType == NodeType.Dir) { dstDirsAll.AddRange(self); dstDirsAll.AddRange(dstDirs.Select(Under)); }

        return new BranchPlan(
            Sync.PlanSync(Rebase(srcSeen.Files), Rebase(dstFiles)),
            srcDirs, dstDirsAll, conflicts, skipped.Select(UnderPath).ToList());
    }

    // Узлы, которые на источнике папка, а на приёмнике файл (или наоборот).
    private static List<string> FindTypeConflicts(ScanResult src, ScanResult dst)
    {
        var outList = new List<string>();
        if (src.Files.Count == 0 && src.Dirs.Count == 0) return outList;
        var dstFileSet = new HashSet<string>(dst.Files.Select(e => Paths.CiKey(e.Path)), StringComparer.Ordinal);
        var dstDirSet = new HashSet<string>(dst.Dirs.Select(Paths.CiKey), StringComparer.Ordinal);
        foreach (var d in src.Dirs) if (dstFileSet.Contains(Paths.CiKey(d))) outList.Add(d);
        foreach (var e in src.Files) if (dstDirSet.Contains(Paths.CiKey(e.Path))) outList.Add(e.Path);
        return outList;
    }

    // Файлы и папки ветки из готового индекса обхода (пути - относительно ветки).
    // Исключения - только те, что внутри самой ветки: самая точная отметка главнее
    // (вложенная ветка, возвращённая внутри снятой). Регистр не участвует: ветку
    // интерфейс берёт с той стороны, что попала в список первой.
    public static ScanResult ScanFromIndex(CrawlSide idx, string branch, IEnumerable<string> excludes)
    {
        var prefix = branch != "" ? $"{branch}/" : "";
        var pfx = Paths.CiKey(prefix);
        // Сравниваем ровно ту часть пути, что займёт префикс: срезать всё равно
        // придётся по длине исходной строки, а не приведённой.
        bool UnderBranch(string rel) =>
            prefix == "" || (rel.Length > prefix.Length && Paths.CiKey(rel[..prefix.Length]) == pfx);

        var branchKey = Paths.CiKey(branch);
        var excluded = UnderAny(excludes.Select(Paths.CiKey).Where(ex => ex != branchKey && ex.StartsWith(pfx, StringComparison.Ordinal)));

        var files = new List<FileEntry>();
        var dirs = new List<string>();
        foreach (var (rel, meta) in idx.Files)
        {
            if (!UnderBranch(rel) || excluded(rel)) continue;
            files.Add(new FileEntry(rel[prefix.Length..], meta.Size, meta.MtimeMs));
        }
        foreach (var rel in idx.Dirs)
        {
            if (!UnderBranch(rel) || excluded(rel)) continue;
            dirs.Add(rel[prefix.Length..]);
        }
        // Закрытые правами - так же, как их отдаёт живой скан: план обязан вести себя
        // одинаково, включён подсчёт размеров или нет.
        var skipped = new List<string>();
        foreach (var rel in idx.Skipped)
        {
            // Закрыт сам корень ветки - живой скан обозначает это пустой строкой.
            if (Paths.CiKey(rel) == branchKey)
            {
                skipped.Add("");
                continue;
            }
            if (!UnderBranch(rel) || excluded(rel)) continue;
            skipped.Add(rel[prefix.Length..]);
        }
        return new ScanResult(files, dirs, skipped);
    }

    // Раскладывает весь индекс обхода по выбранным веткам за один проход: перебор
    // всего индекса на каждую ветку стоил произведения двух законных пределов
    // (5000 веток на 105 тысяч узлов - 83 секунды). Хозяин пути ищется подъёмом
    // по пути; режем по настоящей строке, а не по приведённой.
    public static Dictionary<string, ScanResult> GroupIndexByBranch(CrawlSide idx, IEnumerable<string> folders, IEnumerable<string> excludes)
    {
        var branches = new Dictionary<string, string>(StringComparer.Ordinal);
        var groups = new Dictionary<string, ScanResult>(StringComparer.Ordinal);
        foreach (var f in folders)
        {
            var k = Paths.CiKey(f);
            if (branches.TryAdd(k, f)) groups[k] = ScanResult.Empty();
        }
        var excl = new HashSet<string>(excludes.Select(Paths.CiKey), StringComparer.Ordinal);

        (string Key, string Rel)? OwnerOf(string rel)
        {
            if (excl.Contains(Paths.CiKey(rel))) return null;
            var cut = rel.LastIndexOf('/');
            for (;;)
            {
                var head = cut < 0 ? "" : rel[..cut];
                var k = Paths.CiKey(head);
                if (branches.ContainsKey(k)) return (k, head != "" ? rel[(head.Length + 1)..] : rel);
                if (excl.Contains(k)) return null;
                if (cut < 0) return null;
                cut = head.LastIndexOf('/');
            }
        }

        foreach (var (rel, meta) in idx.Files)
        {
            if (OwnerOf(rel) is { } own) groups[own.Key].Files.Add(new FileEntry(own.Rel, meta.Size, meta.MtimeMs));
        }
        foreach (var rel in idx.Dirs)
        {
            if (OwnerOf(rel) is { } own) groups[own.Key].Dirs.Add(own.Rel);
        }
        foreach (var rel in idx.Skipped)
        {
            // Закрыт сам корень ветки - пустая строка, как у живого скана. Ветке-предку
            // этот же узел виден обычным путём, поэтому достаётся обеим.
            var selfKey = Paths.CiKey(rel);
            if (branches.ContainsKey(selfKey)) groups[selfKey].Skipped.Add("");
            if (OwnerOf(rel) is { } own) groups[own.Key].Skipped.Add(own.Rel);
        }
        return groups;
    }

    // Исключения, разложенные по веткам за один проход: CiKey(ветка) → пути относительно
    // неё. Путь принадлежит всем своим предкам: вложенная ветка выбирается вместе
    // с родителем, и запрет внутри неё виден обеим.
    public static Dictionary<string, HashSet<string>> GroupExcludesByBranch(IEnumerable<string> excludes)
    {
        var byBranch = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var ex in excludes)
        {
            var cut = ex.LastIndexOf('/');
            // cut == 0 быть не может: путь не начинается со слеша. Исключение верхнего
            // уровня ветке не принадлежит - его хозяин корень, а корень веткой не бывает.
            while (cut > 0)
            {
                var head = ex[..cut];
                var k = Paths.CiKey(head);
                if (!byBranch.TryGetValue(k, out var set)) byBranch[k] = set = new HashSet<string>(StringComparer.Ordinal);
                set.Add(ex[(cut + 1)..]);
                cut = head.LastIndexOf('/');
            }
        }
        return byBranch;
    }

    // Есть ли в keys сам путь k или любой его предок - подъёмом по пути, а не перебором.
    private static bool CoveredByKey(HashSet<string> keys, string k)
    {
        var cur = k;
        for (;;)
        {
            if (keys.Contains(cur)) return true;
            var slash = cur.LastIndexOf('/');
            if (slash < 0) return false;
            cur = cur[..slash];
        }
    }

    // Проверка «путь лежит внутри одного из названных узлов (или сам им является)».
    internal static Func<string, bool> UnderAny(IEnumerable<string> paths)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in paths)
        {
            var k = Paths.CiKey(p);
            // Пустой ключ - назван сам корень ветки: не видно вообще ничего.
            if (k == "") return _ => true;
            keys.Add(k);
        }
        if (keys.Count == 0) return _ => false;
        return rel => CoveredByKey(keys, Paths.CiKey(rel));
    }

    // Только верхние узлы списка: без повторов и без вложенных. Сортировка по длине
    // ставит предка раньше потомка; устойчивая, как Array.sort в JS.
    internal static List<string> TopPaths(IEnumerable<string> paths)
    {
        var kept = new List<string>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rel in paths.OrderBy(p => p.Length))
        {
            var k = Paths.CiKey(rel);
            if (CoveredByKey(keys, k)) continue;
            kept.Add(rel);
            keys.Add(k);
        }
        return kept;
    }

    // Сверяет кандидатов в перемещения по содержимому и разворачивает непрошедших
    // обратно в «скопировать + выбросить»: имя, размер и дата совпадают у разных файлов
    // пачкой (распаковка, git checkout, robocopy), и приёмник получал чужое содержимое.
    private static async Task ConfirmMoves(string srcRoot, string dstRoot, SyncPlan plan)
    {
        if (plan.Moves.Count == 0) return;
        var verdicts = new bool[plan.Moves.Count];
        await FsOps.RunPool(Enumerable.Range(0, plan.Moves.Count).ToList(), FsOps.ApplyConcurrency, async i =>
        {
            var mv = plan.Moves[i];
            try { verdicts[i] = await FsOps.SameContent(Path.Join(srcRoot, mv.To), Path.Join(dstRoot, mv.From)); }
            catch { verdicts[i] = false; }
        });

        var confirmed = new List<Move>();
        for (var i = 0; i < plan.Moves.Count; i++)
        {
            var mv = plan.Moves[i];
            if (verdicts[i])
            {
                confirmed.Add(mv);
                continue;
            }
            plan.Copy.Add(mv.Added);
            plan.Trash.Add(mv.Gone);
        }
        plan.Moves = confirmed;
    }

    // Один план на весь запуск: ветки объединяются, и только потом ищутся перемещения -
    // иначе перенос файла между двумя выбранными ветками остался бы незамеченным.
    public static async Task<SyncPlan> BuildRunPlan(string srcRoot, string dstRoot, IReadOnlyList<string> folders,
        IReadOnlyCollection<string> excludes, Scanner scan)
    {
        var merged = new SyncPlan();
        var srcDirs = new List<string>();
        var dstDirs = new List<string>();
        var conflicts = new List<string>();
        var skipped = new List<string>();

        // Типы веток и их родителей - одной пачкой до разбора: см. StatType.
        var types = await PrefetchTypes(srcRoot, dstRoot, folders);

        foreach (var folder in folders)
        {
            var branch = await PlanForBranch(srcRoot, dstRoot, folder, excludes, scan, types);
            merged.Copy.AddRange(branch.Plan.Copy);
            merged.Overwrite.AddRange(branch.Plan.Overwrite);
            merged.Trash.AddRange(branch.Plan.Trash);
            merged.Unchanged.AddRange(branch.Plan.Unchanged);
            srcDirs.AddRange(branch.SrcDirs);
            dstDirs.AddRange(branch.DstDirs);
            conflicts.AddRange(branch.Conflicts);
            skipped.AddRange(branch.Skipped);
        }

        var plan = Sync.DetectMoves(merged);
        await ConfirmMoves(srcRoot, dstRoot, plan);
        plan.Dirs = Sync.PlanDirs(srcDirs, dstDirs);
        plan.Conflicts = TopPaths(conflicts);
        // Закрытые правами папки в работу не входят, но сказать о них обязаны:
        // иначе ветка молча не синхронизируется, а отчёт рапортует «Готово».
        plan.Skipped = TopPaths(skipped);
        return plan;
    }

    private sealed class Counter
    {
        public int Move, Copy, Overwrite, Trash, Unchanged, Dirs;
        public void Add(string key)
        {
            switch (key)
            {
                case "move": Move++; break;
                case "copy": Copy++; break;
                case "overwrite": Overwrite++; break;
                case "trash": Trash++; break;
                case "unchanged": Unchanged++; break;
            }
        }
        public Summary ToSummary() => new(Move, Copy, Overwrite, Trash, Unchanged, Dirs, Move + Copy + Overwrite + Trash + Dirs);
    }

    // Счётчики по каждой выбранной ветке - для списка в окне предпросмотра. Путь
    // засчитываем самой длинной подходящей ветке (вложенная ветка рядом с родителем -
    // законный выбор); ветку ищем подъёмом по пути, а не перебором всех веток.
    public static List<FolderCount> CountByFolder(SyncPlan plan, IReadOnlyList<string> folders)
    {
        var counts = new Dictionary<string, Counter>(StringComparer.Ordinal);
        foreach (var f in folders) counts[f] = new Counter();
        var byKey = new Dictionary<string, Counter>(StringComparer.Ordinal);
        foreach (var f in folders) byKey.TryAdd(Paths.CiKey(f), counts[f]);

        Counter? BucketFor(string rel)
        {
            var k = Paths.CiKey(rel);
            for (;;)
            {
                if (byKey.TryGetValue(k, out var hit)) return hit;
                var slash = k.LastIndexOf('/');
                if (slash < 0) return null;
                k = k[..slash];
            }
        }

        foreach (var mv in plan.Moves) BucketFor(mv.Path)?.Add("move");
        foreach (var (key, list) in new[] { ("copy", plan.Copy), ("overwrite", plan.Overwrite), ("trash", plan.Trash), ("unchanged", plan.Unchanged) })
            foreach (var e in list) BucketFor(e.Path)?.Add(key);
        foreach (var rel in plan.Conflicts) BucketFor(rel)?.Add("trash");

        // Папки считаем чуть шире: к ветке относятся и её собственные родители (для 'a/b/c'
        // план создаёт ещё 'a' и 'a/b'), иначе сумма по строкам не сходилась с итогом.
        // Ветки от длинных к коротким, первую занявшую предка не перебиваем.
        var ownerOfParent = new Dictionary<string, Counter>(StringComparer.Ordinal);
        foreach (var f in folders.OrderByDescending(x => x.Length))
        {
            var k = Paths.CiKey(f);
            for (;;)
            {
                var slash = k.LastIndexOf('/');
                if (slash < 0) break;
                k = k[..slash];
                if (ownerOfParent.ContainsKey(k)) break; // выше уже размечено этой же цепочкой
                ownerOfParent[k] = counts[f];
            }
        }
        Counter? DirBucketFor(string rel) => BucketFor(rel) ?? ownerOfParent.GetValueOrDefault(Paths.CiKey(rel));
        foreach (var rel in plan.Dirs.Create.Concat(plan.Dirs.Remove))
        {
            if (DirBucketFor(rel) is { } bucket) bucket.Dirs++;
        }
        return folders.Select(f => new FolderCount(f, counts[f].ToSummary())).ToList();
    }
}
