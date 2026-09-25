namespace SyncGlass.Core;

// Запись файла: путь относительно корня выбранной папки, разделитель '/'.
// MtimeMs - миллисекунды от 1970 с долями, как mtimeMs у Node.
public sealed record FileEntry(string Path, long Size, double MtimeMs);

// Перемещение: файл пропал на приёмнике по пути From и появился на источнике по пути To.
// Gone и Added - исходные записи пары: не подтвердится сверкой содержимого -
// из них собирается обратно обычная пара «скопировать + выбросить» (см. Sync.PairUp).
public sealed record Move(string From, string To, string Path, long Size, FileEntry Gone, FileEntry Added);

public sealed class DirPlan
{
    public List<string> Create { get; init; } = new();
    public List<string> Remove { get; init; } = new();
}

// План запуска. Изменяемый, как объект плана в JS: сборка плана и сверка
// перемещений дописывают его по месту.
public sealed class SyncPlan
{
    public List<FileEntry> Copy { get; set; } = new();
    public List<FileEntry> Overwrite { get; set; } = new();
    public List<FileEntry> Trash { get; set; } = new();
    public List<FileEntry> Unchanged { get; set; } = new();
    public List<Move> Moves { get; set; } = new();
    public DirPlan Dirs { get; set; } = new();
    public List<string> Conflicts { get; set; } = new();
    public List<string> Skipped { get; set; } = new();
}

// Сводка для окна предпросмотра (и счётчики по веткам в CountByFolder).
public sealed record Summary(int Move, int Copy, int Overwrite, int Trash, int Unchanged, int Dirs, int Total);
