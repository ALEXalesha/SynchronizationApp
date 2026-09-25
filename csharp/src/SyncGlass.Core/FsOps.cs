namespace SyncGlass.Core;

/// <summary>
/// Перенос src/fsops.js: всё, что трогает диск. На этом этапе - только то, что
/// нужно плану (пул работников и сверка содержимого); скан, обход, выполнение
/// плана и откат - следующим этапом.
/// </summary>
public static partial class FsOps
{
    public const int ScanConcurrency = 32;
    public const int ApplyConcurrency = 16;
    public const string StageDir = ".sgundo";

    // Сколько байт сверяем с каждого конца, когда файл крупный. Мелкий читается
    // целиком: именно мелкие файлы (config.json, __init__.py, метки) чаще всего
    // и совпадают по имени с размером, будучи совершенно разными.
    internal const int SampleBytes = 65536;

    // Пул работников над списком: не больше concurrency задач разом, следующий
    // элемент берёт освободившийся работник. Как runPool в JS - порядок старта
    // элементов тот же, порядок завершения не обещан.
    public static async Task RunPool<T>(IReadOnlyList<T> items, int concurrency, Func<T, Task> worker)
    {
        var next = -1;
        var n = Math.Min(concurrency, items.Count);
        var runners = new Task[n];
        for (var c = 0; c < n; c++)
        {
            runners[c] = Task.Run(async () =>
            {
                int idx;
                while ((idx = Interlocked.Increment(ref next)) < items.Count) await worker(items[idx]);
            });
        }
        await Task.WhenAll(runners);
    }

    // Читает до size байт с позиции pos. Файл мог укоротиться после stat - тогда
    // отдаём сколько есть, как readAt в JS, а не бросаем.
    private static async Task<byte[]> ReadAt(FileStream fh, int size, long pos)
    {
        var buf = new byte[size];
        var got = 0;
        fh.Position = pos;
        while (got < size)
        {
            var read = await fh.ReadAsync(buf.AsMemory(got, size - got));
            if (read == 0) break;
            got += read;
        }
        return got == size ? buf : buf[..got];
    }

    private static async Task<byte[]> Edges(string file, long size)
    {
        await using var fh = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete,
                                            4096, useAsync: true);
        if (size <= SampleBytes * 2) return await ReadAt(fh, (int)size, 0);
        var head = await ReadAt(fh, SampleBytes, 0);
        var tail = await ReadAt(fh, SampleBytes, size - SampleBytes);
        return [.. head, .. tail];
    }

    // Один ли это файл на двух сторонах. Читаем края, а не весь файл: переименование
    // дерева на сотню гигабайт иначе стоило бы столько же, сколько копирование,
    // а ради этого перемещения и распознаются. Нет файла - исключение, как у stat
    // в JS; вызывающий (Plan.ConfirmMoves) считает это «не тот же».
    public static async Task<bool> SameContent(string a, string b)
    {
        var fa = new FileInfo(a);
        var fb = new FileInfo(b);
        if (!fa.Exists && !Directory.Exists(a)) throw new FileNotFoundException(null, a);
        if (!fb.Exists && !Directory.Exists(b)) throw new FileNotFoundException(null, b);
        if (!fa.Exists || !fb.Exists || fa.Length != fb.Length) return false;
        if (fa.Length == 0) return true;
        var both = await Task.WhenAll(Edges(a, fa.Length), Edges(b, fb.Length));
        return both[0].AsSpan().SequenceEqual(both[1]);
    }
}
