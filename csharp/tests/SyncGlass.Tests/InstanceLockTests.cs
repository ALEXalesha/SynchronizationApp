using System.Diagnostics;
using SyncGlass.Core.Main;

namespace SyncGlass.Tests;

// Общий замок двух версий: именованный канал. Имена в тестах уникальные - чтобы
// не задеть живой SyncGlass, открытый у пользователя.
public class InstanceLockTests
{
    private static string Unique() => "SyncGlass-test-" + Guid.NewGuid().ToString("N");

    private static async Task<bool> WaitFor(Func<bool> cond, int ms = 5000)
    {
        var sw = Stopwatch.StartNew();
        while (!cond() && sw.ElapsedMilliseconds < ms) await Task.Delay(20);
        return cond();
    }

    [Fact]
    public async Task вторая_копия_не_занимает_замок_а_зовёт_первую_показаться()
    {
        var name = Unique();
        var shown = 0;
        using var first = InstanceLock.TryAcquire(() => Interlocked.Increment(ref shown), name);
        Assert.NotNull(first);

        var second = InstanceLock.TryAcquire(() => { }, name);
        Assert.Null(second);
        Assert.True(await WaitFor(() => Volatile.Read(ref shown) == 1), "первая копия не получила «show»");

        // Замок не отпускается после клиента: третья копия тоже получает отказ.
        Assert.Null(InstanceLock.TryAcquire(() => { }, name));
        Assert.True(await WaitFor(() => Volatile.Read(ref shown) == 2));
    }

    [Fact]
    public void после_закрытия_первой_копии_замок_свободен()
    {
        var name = Unique();
        var first = InstanceLock.TryAcquire(() => { }, name);
        Assert.NotNull(first);
        first!.Dispose();
        using var again = InstanceLock.TryAcquire(() => { }, name);
        Assert.NotNull(again);
    }

    // Electron держит тот же канал через net.createServer - C# обязан получить отказ,
    // а «show» обязан дойти до Node. И наоборот.
    private static Process StartNode(string script, params string[] args)
    {
        var psi = new ProcessStartInfo("node") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        psi.ArgumentList.Add(script);
        foreach (var a in args) psi.ArgumentList.Add(a);
        return Process.Start(psi)!;
    }

    private const string NodeHolder = """
        const net = require('net');
        const name = '\\\\.\\pipe\\' + process.argv[2];
        const srv = net.createServer((s) => s.on('data', (d) => console.log('got ' + d)));
        srv.on('error', (e) => { console.log('refused ' + e.code); process.exit(2); });
        srv.listen(name, () => console.log('holds'));
        setTimeout(() => process.exit(0), 8000);
        """;

    [Fact]
    public async Task замок_Node_отказывает_CSharp_и_получает_от_него_show()
    {
        using var t = new TempDir();
        t.Write("holder.js", NodeHolder);
        var name = Unique();
        using var node = StartNode(t.P("holder.js"), name);
        try
        {
            Assert.Equal("holds", await node.StandardOutput.ReadLineAsync());
            Assert.Null(InstanceLock.TryAcquire(() => { }, name));
            Assert.Equal("got show", await node.StandardOutput.ReadLineAsync());
        }
        finally
        {
            if (!node.HasExited) node.Kill();
        }
    }

    [Fact]
    public async Task замок_CSharp_отказывает_Node()
    {
        using var t = new TempDir();
        t.Write("holder.js", NodeHolder);
        var name = Unique();
        using var mine = InstanceLock.TryAcquire(() => { }, name);
        Assert.NotNull(mine);
        using var node = StartNode(t.P("holder.js"), name);
        var line = await node.StandardOutput.ReadLineAsync();
        await node.WaitForExitAsync();
        Assert.StartsWith("refused", line);
        Assert.Equal(2, node.ExitCode);
    }
}
