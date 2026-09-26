using SyncGlass.Core.Main;

namespace SyncGlass.Tests;

// Закон памяти кеша размеров: чтение и запись кеша тратят память пропорционально самим
// записям, а не тексту файла.
//
// Нашёл живой прогон C#-версии на данных Алексея 26.09.2026: окно держало 1,3 ГБ.
// Замер по шагам: кеш на 300 тысяч записей (49 МБ) при чтении поднимал кучу до 623 МБ -
// файл целиком читался в строку (вдвое больше файла, UTF-16), а из неё строилось дерево
// JsonNode на каждое поле. Запись собирала весь JSON в одну строку: ещё +160 МБ. Сам
// список записей при этом весит около 120 МБ.
//
// Меряются выделенные байты, а не пик: выделенное - верхняя граница пика и не зависит
// от того, когда сработал сборщик. Считаются байты СВОЕГО потока (ядро чтения и записи
// синхронное): счётчик всего процесса в CI поймал фон соседних тестов - «645 МБ на
// чтение» при честных 20.
//
// ЧЕГО ЭТОТ ЗАКОН НЕ СПРАШИВАЕТ: сам индекс обхода (словарь путей в Backend) - он нужен
// для предпросмотра и живёт, пока жив обход; его размер растёт с деревом по устройству.
[Collection("Законы масштаба")]
public class CacheMemoryTests
{
    private const int Записей = 100_000;

    private static List<SizeEntry> Записи() => Enumerable.Range(0, Записей)
        .Select(i => new SizeEntry($"Проекты/ветка {i % 97}/папка {i % 1013}/файл номер {i}.txt",
                                   i * 37L, i % 5 == 0 ? null : 1, i % 3 == 0 ? null : i * 11L, i % 3 == 0 ? null : 1))
        .ToList();

    private static long Выделено(Action action)
    {
        var before = GC.GetAllocatedBytesForCurrentThread();
        action();
        return GC.GetAllocatedBytesForCurrentThread() - before;
    }

    [Fact]
    public void чтение_кеша_не_тратит_память_на_текст_файла()
    {
        using var dir = new TempDir();
        var store = new SizeCacheStore(dir.Root);
        store.SaveSync("L", "N", Записи());
        var файл = new FileInfo(store.FileFor("L", "N")).Length;

        List<SizeEntry>? got = null;
        var чтение = Выделено(() => got = store.LoadSync("L", "N"));

        Assert.Equal(Записей, got!.Count);
        // Сами записи: объект и строка пути - примерно полтора размера файла. Старое
        // чтение тратило больше десяти.
        Assert.True(чтение <= 2.5 * файл, $"чтение кеша {файл / 1048576.0:F1} МБ выделило {чтение / 1048576.0:F0} МБ ({чтение / (double)файл:F1}× файла)");
    }

    [Fact]
    public void запись_кеша_не_собирает_файл_в_памяти()
    {
        using var dir = new TempDir();
        var store = new SizeCacheStore(dir.Root);
        var записи = Записи();
        // Save - та же SaveSync, унесённая в пул; меряем ядро.
        var запись = Выделено(() => store.SaveSync("L", "N", записи));
        var файл = new FileInfo(store.FileFor("L", "N")).Length;

        Assert.True(запись <= 0.5 * файл, $"запись кеша {файл / 1048576.0:F1} МБ выделила {запись / 1048576.0:F0} МБ");
    }
}
