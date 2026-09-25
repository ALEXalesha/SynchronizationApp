namespace SyncGlass.Core;

public static partial class FsOps
{
    // Подмена stat для тестов, как подмена fsp.stat в JS-тестах: законы масштаба
    // считают обращения к диску, а не время. AsyncLocal, а не простое поле: xUnit
    // гоняет классы тестов параллельно, и подмена одного теста не должна доставаться
    // соседу. Значение течёт в Task.Run внутри RunPool вместе с контекстом.
    internal static readonly AsyncLocal<Func<string, Task<FileAttributes?>>?> StatOverride = new();

    // Наблюдатель обращений к диску для законов масштаба: каждый stat и каждое чтение
    // папки с путём. Настоящие вызовы выполняются - закон меряет живое поведение.
    internal static readonly AsyncLocal<Action<string>?> DiskObserver = new();

    // Атрибуты узла или null, если его нет. Нет узла - это и ENOENT, и ENOTDIR
    // (один из предков - файл; Windows и вовсе отвечает на это «путь не найден»).
    // Остальные ошибки летят дальше, как у stat в JS.

    internal static Task<FileAttributes?> StatAttributes(string full)
    {
        DiskObserver.Value?.Invoke(full);
        var hook = StatOverride.Value;
        if (hook != null) return hook(full);
        try
        {
            return Task.FromResult<FileAttributes?>(File.GetAttributes(full));
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return Task.FromResult<FileAttributes?>(null);
        }
    }

    // mtimeMs как у Node: миллисекунды от 1970 с долями.
    public static double ToMs(DateTime utc) => (utc - DateTime.UnixEpoch).TotalMilliseconds;
}
