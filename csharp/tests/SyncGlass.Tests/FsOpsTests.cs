using SyncGlass.Core;

namespace SyncGlass.Tests;

// Перенос test/fsops.test.js. Этап 1: пул и сверка содержимого - у JS на них
// отдельных тестов нет, здесь они свои.
public class FsOpsTests
{
    [Fact]
    public async Task runPool_обрабатывает_каждый_элемент_ровно_один_раз()
    {
        var items = Enumerable.Range(0, 1000).ToList();
        var seen = new int[items.Count];
        await FsOps.RunPool(items, 16, async i => { await Task.Yield(); Interlocked.Increment(ref seen[i]); });
        Assert.All(seen, n => Assert.Equal(1, n));
    }

    // Пул и нужен ради предела: по сети сотни обращений разом кладут шару.
    [Fact]
    public async Task runPool_держит_в_работе_не_больше_concurrency()
    {
        var inFlight = 0;
        var peak = 0;
        await FsOps.RunPool(Enumerable.Range(0, 200).ToList(), 7, async _ =>
        {
            var now = Interlocked.Increment(ref inFlight);
            InterlockedMax(ref peak, now);
            await Task.Delay(1);
            Interlocked.Decrement(ref inFlight);
        });
        Assert.Equal(7, peak);
    }

    [Fact]
    public async Task runPool_на_пустом_списке_сразу_завершается()
    {
        var called = false;
        await FsOps.RunPool(new List<int>(), 4, _ => { called = true; return Task.CompletedTask; });
        Assert.False(called);
    }

    [Fact]
    public async Task runPool_пробрасывает_ошибку_работника()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            FsOps.RunPool(new[] { 1, 2, 3 }, 2, i => i == 2 ? throw new InvalidOperationException() : Task.CompletedTask));
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int cur;
        while (value > (cur = Volatile.Read(ref target)) && Interlocked.CompareExchange(ref target, value, cur) != cur) { }
    }

    [Fact]
    public async Task sameContent_одинаковые_файлы()
    {
        using var t = new TempDir();
        t.Write("a/x.txt", "привет");
        t.Write("b/x.txt", "привет");
        Assert.True(await FsOps.SameContent(t.P("a/x.txt"), t.P("b/x.txt")));
    }

    // Мелкие файлы читаются целиком: config.json с разницей в середине - разные.
    [Fact]
    public async Task sameContent_мелкие_файлы_с_разницей_в_середине_разные()
    {
        using var t = new TempDir();
        var a = new byte[100_000];
        var b = (byte[])a.Clone();
        b[50_000] = 1;
        t.WriteBytes("a.bin", a);
        t.WriteBytes("b.bin", b);
        Assert.False(await FsOps.SameContent(t.P("a.bin"), t.P("b.bin")));
    }

    // Крупные сверяются по краям - это осознанная цена за мгновенное перемещение
    // (см. комментарий в src/fsops.js). Разница в середине сверкой не видна.
    [Fact]
    public async Task sameContent_крупные_файлы_сверяются_по_краям()
    {
        using var t = new TempDir();
        var size = FsOps.SampleBytes * 2 + 10;
        var a = new byte[size];
        var mid = (byte[])a.Clone();
        mid[FsOps.SampleBytes + 5] = 1;
        var head = (byte[])a.Clone();
        head[10] = 1;
        var tail = (byte[])a.Clone();
        tail[size - 10] = 1;
        t.WriteBytes("a.bin", a);
        t.WriteBytes("mid.bin", mid);
        t.WriteBytes("head.bin", head);
        t.WriteBytes("tail.bin", tail);
        Assert.True(await FsOps.SameContent(t.P("a.bin"), t.P("mid.bin")));
        Assert.False(await FsOps.SameContent(t.P("a.bin"), t.P("head.bin")));
        Assert.False(await FsOps.SameContent(t.P("a.bin"), t.P("tail.bin")));
    }

    // Края совпадают, а длина нет: по краям их не отличить, решает размер.
    [Fact]
    public async Task sameContent_крупные_файлы_разной_длины_с_одинаковыми_краями_разные()
    {
        using var t = new TempDir();
        t.WriteBytes("a.bin", new byte[FsOps.SampleBytes * 3]);
        t.WriteBytes("b.bin", new byte[FsOps.SampleBytes * 3 + 1]);
        Assert.False(await FsOps.SameContent(t.P("a.bin"), t.P("b.bin")));
    }

    // Ровно два края сверяются целиком (любой байт - в одном из краёв). Замена <= на <
    // здесь равносильна: края такого файла и есть весь файл.
    [Fact]
    public async Task sameContent_файл_ровно_в_два_края_читается_целиком()
    {
        using var t = new TempDir();
        var a = new byte[FsOps.SampleBytes * 2];
        var b = (byte[])a.Clone();
        b[FsOps.SampleBytes] = 1; // первый байт второй половины - вне голового края
        t.WriteBytes("a.bin", a);
        t.WriteBytes("b.bin", b);
        Assert.False(await FsOps.SameContent(t.P("a.bin"), t.P("b.bin")));
    }

    [Fact]
    public async Task sameContent_разный_размер_разные()
    {
        using var t = new TempDir();
        t.Write("a.txt", "abc");
        t.Write("b.txt", "abcd");
        Assert.False(await FsOps.SameContent(t.P("a.txt"), t.P("b.txt")));
    }

    [Fact]
    public async Task sameContent_пустые_файлы_одинаковые()
    {
        using var t = new TempDir();
        t.Write("a.txt", "");
        t.Write("b.txt", "");
        Assert.True(await FsOps.SameContent(t.P("a.txt"), t.P("b.txt")));
    }

    [Fact]
    public async Task sameContent_папка_против_файла_разные()
    {
        using var t = new TempDir();
        t.Mkdir("d");
        t.Write("f.txt", "x");
        Assert.False(await FsOps.SameContent(t.P("d"), t.P("f.txt")));
    }

    // Как stat в JS: нет файла - ошибка, а решение «не тот же» принимает вызывающий.
    [Fact]
    public async Task sameContent_нет_файла_ошибка()
    {
        using var t = new TempDir();
        t.Write("a.txt", "x");
        await Assert.ThrowsAsync<FileNotFoundException>(() => FsOps.SameContent(t.P("a.txt"), t.P("нет.txt")));
        await Assert.ThrowsAsync<FileNotFoundException>(() => FsOps.SameContent(t.P("нет.txt"), t.P("a.txt")));
    }
}
