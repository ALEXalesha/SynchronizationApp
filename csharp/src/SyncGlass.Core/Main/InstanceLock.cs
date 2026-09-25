using System.IO.Pipes;

namespace SyncGlass.Core.Main;

/// <summary>
/// Один экземпляр SyncGlass на пользователя - общий для C# и Electron. Две копии делят
/// служебную папку на приёмнике и кеши в %APPDATA%\SyncGlass: разбор служебной папки
/// второй вернул бы «брошенные» оригиналы прямо из-под первой, которая ими занята.
///
/// Замок - именованный канал \\.\pipe\SyncGlass-&lt;пользователь&gt;: занять его может только
/// один процесс (FirstPipeInstance), освобождается он сам, когда процесс умирает, - после
/// вылета зависшего замка не бывает. Вторая копия шлёт в канал «show», первая выходит
/// вперёд. Electron занимает тот же канал через net.createServer (проба 26.09.2026:
/// отказ в любой паре Node/.NET).
/// </summary>
public sealed class InstanceLock : IDisposable
{
    public static string PipeName(string? user = null) => "SyncGlass-" + (user ?? Environment.UserName);

    private readonly string _name;
    private readonly Action _onShow;
    private readonly CancellationTokenSource _stop = new();
    private NamedPipeServerStream? _server;

    private InstanceLock(string name, Action onShow)
    {
        _name = name;
        _onShow = onShow;
    }

    // Занять замок. null - уже занят другой копией (ей отправлено «show»).
    public static InstanceLock? TryAcquire(Action onShow, string? name = null)
    {
        var l = new InstanceLock(name ?? PipeName(), onShow);
        if (l.Listen()) return l;
        SendShow(l._name);
        return null;
    }

    private bool Listen()
    {
        try
        {
            // Одного экземпляра канала хватает, чтобы отказать второй копии (мутацией
            // проверено); FirstPipeInstance - запас: «первый экземпляр» ровно то, что нужно.
            _server = new NamedPipeServerStream(_name, PipeDirection.In, 1, PipeTransmissionMode.Byte,
                                                PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false; // канал держит другая копия (.NET - IOException, Node - отказ в доступе)
        }
        _ = Serve();
        return true;
    }

    // Принимает «show» от вторых копий. Канал с одним экземпляром: после каждого
    // клиента тот же экземпляр отключается и ждёт следующего - замок не отпускается.
    private async Task Serve()
    {
        var server = _server!;
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                await server.WaitForConnectionAsync(_stop.Token);
                using var reader = new StreamReader(server, leaveOpen: true);
                var msg = await reader.ReadToEndAsync(_stop.Token);
                if (msg.Contains("show", StringComparison.Ordinal)) _onShow();
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                // клиент оборвался - ждём следующего
            }
            // Отключать обязательно и после ушедшего клиента: канал тогда «сломан»,
            // IsConnected уже false, но без Disconnect следующего клиента он не примет.
            try { server.Disconnect(); } catch { /* уже отключён */ }
        }
    }

    public static void SendShow(string? name = null)
    {
        try
        {
            using var c = new NamedPipeClientStream(".", name ?? PipeName(), PipeDirection.Out);
            c.Connect(2000);
            using var w = new StreamWriter(c);
            w.Write("show");
        }
        catch
        {
            // первая копия занята или уже закрывается - окно просто не выйдет вперёд
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _server?.Dispose();
    }
}
