namespace SyncGlass.Core;

/// <summary>
/// Перенос src/sync.js: чистая логика планирования синхронизации. Никаких файловых
/// операций - только сравнение двух списков записей. Полные объяснения «почему» -
/// в комментариях src/sync.js, здесь сокращённо.
/// </summary>
public static class Sync
{
    // Порог различия времени. Разные файловые системы (NTFS, сеть) округляют mtime
    // по-разному, поэтому небольшую дельту считаем «одинаковым».
    public const double MtimeToleranceMs = 2000;

    // Индекс по пути без учёта регистра: стороны сравниваются так же, как их
    // сравнивает сама файловая система. Повтор ключа перезаписывает, как Map.set.
    private static Dictionary<string, FileEntry> IndexByPath(IEnumerable<FileEntry> entries)
    {
        var map = new Dictionary<string, FileEntry>(StringComparer.Ordinal);
        foreach (var e in entries) map[Paths.CiKey(e.Path)] = e;
        return map;
    }

    public static bool IsChanged(FileEntry src, FileEntry dst)
    {
        if (src.Size != dst.Size) return true;
        return Math.Abs(src.MtimeMs - dst.MtimeMs) > MtimeToleranceMs;
    }

    // Строит план приведения приёмника к копии источника: copy, overwrite, trash, unchanged.
    public static SyncPlan PlanSync(IReadOnlyList<FileEntry> sourceEntries, IReadOnlyList<FileEntry> destEntries)
    {
        var srcIndex = IndexByPath(sourceEntries);
        var dstIndex = IndexByPath(destEntries);
        var plan = new SyncPlan();

        foreach (var src in sourceEntries)
        {
            if (!dstIndex.TryGetValue(Paths.CiKey(src.Path), out var dst))
                plan.Copy.Add(src);
            else if (BaseName(src.Path) != BaseName(dst.Path) || IsChanged(src, dst))
                // Имена совпали, но написаны по-разному ('Note.txt' против 'note.txt') -
                // перезаписываем даже при одинаковом содержимом: перезапись начинается
                // с переноса оригинала в служебную папку, и на месте остаётся имя
                // источника. Сравниваем только имя файла, не весь путь: написание
                // папки-предка так не чинится, и файл уходил бы в перезапись вечно.
                plan.Overwrite.Add(src);
            else
                plan.Unchanged.Add(src);
        }

        foreach (var dst in destEntries)
            if (!srcIndex.ContainsKey(Paths.CiKey(dst.Path))) plan.Trash.Add(dst);

        return plan;
    }

    internal static string BaseName(string relPath)
    {
        var slash = relPath.LastIndexOf('/');
        return slash >= 0 ? relPath[(slash + 1)..] : relPath;
    }

    // Основной ключ - размер и имя файла. Дата не в ключе намеренно: шары и FAT
    // округляют её по-своему. Дату проверяем отдельно, с тем же допуском.
    private static string KeyByName(FileEntry entry) => $"{entry.Size}:{Paths.CiKey(BaseName(entry.Path))}";

    // Группы в порядке первого появления ключа, как Map в JS.
    private static Dictionary<string, List<FileEntry>> GroupBy(IEnumerable<FileEntry> entries, Func<FileEntry, string> keyOf)
    {
        var groups = new Dictionary<string, List<FileEntry>>(StringComparer.Ordinal);
        foreach (var e in entries)
        {
            var key = keyOf(e);
            if (groups.TryGetValue(key, out var bucket)) bucket.Add(e);
            else groups[key] = new List<FileEntry> { e };
        }
        return groups;
    }

    // Сводит пары там, где по ключу ровно один кандидат с каждой стороны.
    // При нескольких одинаковых непонятно, что куда переложили - лучше лишний раз
    // скопировать, чем перепутать файлы. sameFile - последняя проверка перед тем,
    // как признать пару кандидатом; решает сверка содержимого в Plan.ConfirmMoves.
    private static (List<FileEntry> Gone, List<FileEntry> Added) PairUp(
        List<FileEntry> gone, List<FileEntry> added, Func<FileEntry, string> keyOf,
        Func<FileEntry, FileEntry, bool> sameFile, List<Move> moves)
    {
        var goneBy = GroupBy(gone, keyOf);
        var addedBy = GroupBy(added, keyOf);
        var taken = new HashSet<string>(StringComparer.Ordinal);

        foreach (var (key, from) in goneBy)
        {
            if (!addedBy.TryGetValue(key, out var to) || from.Count != 1 || to.Count != 1) continue;
            if (!sameFile(to[0], from[0])) continue;
            moves.Add(new Move(from[0].Path, to[0].Path, to[0].Path, to[0].Size, from[0], to[0]));
            taken.Add(from[0].Path);
            taken.Add(to[0].Path);
        }

        return (gone.Where(e => !taken.Contains(e.Path)).ToList(),
                added.Where(e => !taken.Contains(e.Path)).ToList());
    }

    // Выделяет из плана перемещения: то, что иначе ушло бы в trash и заново
    // скопировалось бы по новому пути. Пара признаётся только при совпадении имени:
    // проход по одному «размер + дата» тихо портил данные (распаковка архива,
    // git checkout, robocopy ставят одинаковые даты пачкой) - см. src/sync.js.
    public static SyncPlan DetectMoves(SyncPlan plan)
    {
        var moves = new List<Move>();
        var rest = PairUp(plan.Trash, plan.Copy, KeyByName, (src, dst) => !IsChanged(src, dst), moves);
        return new SyncPlan
        {
            Copy = rest.Added,
            Overwrite = plan.Overwrite,
            Trash = rest.Gone,
            Unchanged = plan.Unchanged,
            Moves = moves,
            Dirs = plan.Dirs,
            Conflicts = plan.Conflicts,
            Skipped = plan.Skipped,
        };
    }

    // Убирает повторы без учёта регистра, сохраняя первое написание.
    private static List<string> UniqueDirs(IEnumerable<string> dirs)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var outList = new List<string>();
        foreach (var d in dirs)
            if (seen.Add(Paths.CiKey(d))) outList.Add(d);
        return outList;
    }

    // Какие папки создать на приёмнике и какие с него убрать, чтобы структура совпала.
    // Удаление идёт от глубоких к мелким, поэтому обратная сортировка. Сортировка -
    // по кодам UTF-16, как Array.sort в JS: порядок не должен зависеть от локали.
    public static DirPlan PlanDirs(IEnumerable<string> srcDirs, IEnumerable<string> dstDirs)
    {
        var srcList = srcDirs.ToList();
        var dstList = dstDirs.ToList();
        var src = new HashSet<string>(srcList.Select(Paths.CiKey), StringComparer.Ordinal);
        var dst = new HashSet<string>(dstList.Select(Paths.CiKey), StringComparer.Ordinal);
        var create = UniqueDirs(srcList).Where(d => !dst.Contains(Paths.CiKey(d))).ToList();
        create.Sort(StringComparer.Ordinal);
        var remove = UniqueDirs(dstList).Where(d => !src.Contains(Paths.CiKey(d))).ToList();
        remove.Sort(StringComparer.Ordinal);
        remove.Reverse();
        return new DirPlan { Create = create, Remove = remove };
    }

    // Сводка плана для окна предпросмотра. Конфликты типа (папка против файла)
    // считаем удалением: с приёмника узел действительно убирается.
    public static Summary Summarize(SyncPlan plan)
    {
        var moves = plan.Moves.Count;
        var dirs = plan.Dirs.Create.Count + plan.Dirs.Remove.Count;
        var trash = plan.Trash.Count + plan.Conflicts.Count;
        return new Summary(moves, plan.Copy.Count, plan.Overwrite.Count, trash, plan.Unchanged.Count, dirs,
            moves + plan.Copy.Count + plan.Overwrite.Count + trash + dirs);
    }
}
