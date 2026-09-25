using System.Text.Json;
using SyncGlass.Core;
using SyncGlass.Core.Main;

namespace SyncGlass.Tests;

// Сборщик событий обхода - как sent в харнессе main.js.
internal sealed class RecordingSink : ICrawlSink
{
    public readonly List<SizeEntry> Cached = new();
    public readonly List<(int Scanned, List<SizeEntry> Entries)> Progresses = new();
    public readonly List<CrawlDone> Dones = new();
    public Action? OnFirstProgress;

    void ICrawlSink.Cached(List<SizeEntry> entries)
    {
        lock (this) Cached.AddRange(entries);
    }

    void ICrawlSink.Progress(int scanned, List<SizeEntry> entries)
    {
        Action? first;
        lock (this)
        {
            Progresses.Add((scanned, entries));
            first = OnFirstProgress;
            OnFirstProgress = null;
        }
        first?.Invoke();
    }

    void ICrawlSink.Done(CrawlDone done)
    {
        lock (this) Dones.Add(done);
    }
}

// Перенос test/main.test.js и test/history.test.js: обработчики main.js на настоящих
// временных папках - тот же путь, которым ходит окно, только без окна.
public sealed class BackendTests : IDisposable
{
    private readonly TempDir _userData = new();
    private readonly Backend _b;

    public BackendTests() => _b = new Backend(_userData.Root);

    public void Dispose() => _userData.Dispose();

    // Снимок дерева с содержимым файлов - для сравнения сторон целиком.
    private static List<string> Snapshot(string root)
        => TestUtil.TreeOf(root).Select(r => r.EndsWith('/') ? r : $"{r}={File.ReadAllText(Path.Join(root, r))}").ToList();

    private static SyncArgs Args(TempDir local, TempDir network, string[] folders, string[]? excludes = null, string direction = "toNetwork")
        => new(local.Root, network.Root, folders, excludes ?? [], direction);

    [Fact]
    public async Task листинг_схлопывает_разное_написание_в_одну_строку_и_помечает_обе_стороны()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("Отчёты/a.txt", "1");
        network.Write("отчёты/b.txt", "2");
        network.Write("Только-в-сети/c.txt", "3");

        var r = await _b.ListFolders(local.Root, network.Root, "");

        Assert.Equal(2, r.Items.Count);
        var общая = r.Items.Single(i => Paths.CiKey(i.Name) == "отчёты");
        Assert.True(общая.HasLocal && общая.HasNetwork);
        Assert.True(r.LocalOk);
        Assert.True(r.NetworkOk);
    }

    [Fact]
    public async Task листинг_отличает_недоступную_сторону_от_пустой()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        var r = await _b.ListFolders(local.P("нет-такой"), network.Root, "");
        Assert.False(r.LocalOk);
        Assert.True(r.NetworkOk);
    }

    [Fact]
    public async Task предпросмотр_и_синхронизация_стороны_сходятся_повтор_пуст()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/новый.txt", "новое");
        local.Write("док/общий.txt", "одинаково");
        network.Write("док/общий.txt", "одинаково");
        network.Write("док/лишний.txt", "убрать");
        File.SetLastWriteTimeUtc(network.P("док/общий.txt"), File.GetLastWriteTimeUtc(local.P("док/общий.txt")));

        var args = Args(local, network, ["док"]);
        var pv = await _b.Preview(args);
        Assert.Equal(1, pv.Totals!.Copy);
        Assert.Equal(1, pv.Totals.Trash);
        Assert.Equal(pv.Totals.Total, pv.PerFolder![0].Summary.Total);

        var res = await _b.Sync(args);
        Assert.Null(res.Error);
        Assert.Equal(0, res.Failures);
        Assert.Equal(Snapshot(local.Root), Snapshot(network.Root));

        var again = await _b.Preview(args);
        Assert.Equal(0, again.Totals!.Total);
    }

    [Fact]
    public async Task план_по_индексу_фонового_обхода_совпадает_с_планом_по_живому_скану()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/новый.txt", "новое");
        network.Write("док/лишний.txt", "убрать");

        var args = Args(local, network, ["док"]);
        var живой = await _b.Preview(args);
        await _b.StartCrawl(local.Root, network.Root, false, new RecordingSink());
        var поИндексу = await _b.Preview(args);

        Assert.Equal(живой.Totals, поИндексу.Totals);
    }

    // Битый кеш (обрыв записи, правка руками) уезжал в окно как готовые размеры, и первая
    // же строка мусора роняла приём обхода.
    [Fact]
    public async Task битый_кеш_размеров_не_выдаётся_за_готовые_размеры()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/ф.txt", "раз");
        var файл = _b.SizeCache.FileFor(local.Root, network.Root);

        foreach (var мусор in new[] { "\"вместо массива строка\"", "5", "[1, 2]", "[{\"нет\":\"пути\"}, null]" })
        {
            var json = $"{{\"localPath\":{JsonSerializer.Serialize(local.Root)},\"networkPath\":{JsonSerializer.Serialize(network.Root)},\"entries\":{мусор}}}";
            File.WriteAllText(файл, json);
            var sink = new RecordingSink();
            var r = await _b.StartCrawl(local.Root, network.Root, false, sink);

            Assert.True(r.Ok, $"обход обязан пройти, а не упасть на кеше {мусор}");
            Assert.All(sink.Cached, e => Assert.NotNull(e.RelPath));
            Assert.Empty(sink.Cached);
        }
    }

    // Закрытие окна посреди обхода: сохранение своё, синхронное, и писать обязано через
    // временный файл - обрезок вместо целого кеша следующий запуск не разберёт.
    [Fact]
    public async Task прогресс_обхода_сохранённый_при_закрытии_читается_следующим_запуском()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        for (var i = 0; i < 400; i++) local.Write($"док/п{i % 20}/ф{i}.txt", new string('x', i));

        string? данные = null;
        var sink = new RecordingSink();
        // Закрываем окно ровно посреди обхода - на первой пачке прогресса.
        sink.OnFirstProgress = () =>
        {
            _b.BeforeQuit();
            данные = File.ReadAllText(_b.SizeCache.FileFor(local.Root, network.Root));
        };
        await _b.StartCrawl(local.Root, network.Root, false, sink);

        Assert.NotNull(данные);
        using var doc = JsonDocument.Parse(данные!);
        Assert.Equal(local.Root, doc.RootElement.GetProperty("localPath").GetString());
        var entries = doc.RootElement.GetProperty("entries");
        Assert.True(entries.GetArrayLength() > 0, "при закрытии сохранилось пусто");
        Assert.All(entries.EnumerateArray(), e => Assert.Equal(JsonValueKind.String, e.GetProperty("relPath").ValueKind));
        Assert.Empty(Directory.GetFiles(_userData.Root, "*.tmp"));
    }

    [Fact]
    public async Task исключённая_ветка_не_копируется_и_не_удаляется()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/внутри/a.txt", "A");
        local.Write("док/скрыто/b.txt", "B");
        network.Write("док/скрыто/своё.txt", "не трогать");

        await _b.Sync(Args(local, network, ["док"], ["док/скрыто"]));

        Assert.True(File.Exists(network.P("док/скрыто/своё.txt")));
        Assert.False(File.Exists(network.P("док/скрыто/b.txt")));
        Assert.True(File.Exists(network.P("док/внутри/a.txt")));
    }

    [Fact]
    public async Task вложенная_ветка_внутри_исключённой_всё_таки_синхронизируется()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/a/b/нужный.txt", "нужен");
        local.Write("док/a/мимо.txt", "мимо");
        local.Write("док/прочее.txt", "обычный");

        await _b.Sync(Args(local, network, ["док", "док/a/b"], ["док/a"]));

        Assert.True(File.Exists(network.P("док/a/b/нужный.txt")));
        Assert.False(File.Exists(network.P("док/a/мимо.txt")));
        Assert.True(File.Exists(network.P("док/прочее.txt")));
    }

    [Fact]
    public async Task недоступный_источник_синхронизация_не_начинается_приёмник_цел()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        network.Write("док/ценное.txt", "не удалять");

        var res = await _b.Sync(new SyncArgs(local.P("нет-такой"), network.Root, ["док"], [], "toNetwork"));

        Assert.NotNull(res.Error);
        Assert.False(res.Started);
        Assert.True(File.Exists(network.P("док/ценное.txt")));
    }

    [Fact]
    public async Task вложенные_корни_отклоняются()
    {
        using var local = new TempDir();
        local.Write("внутри/x.txt", "1");
        var res = await _b.Sync(new SyncArgs(local.Root, local.P("внутри"), ["внутри"], [], "toNetwork"));
        Assert.Contains("вложены друг в друга", res.Error);
    }

    // Два запуска разом делят служебную папку: разбор второго вернул бы оригиналы
    // прямо из-под первого.
    [Fact]
    public async Task второй_одновременный_запуск_отклоняется_а_не_портит_приёмник()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        for (var i = 0; i < 30; i++) local.Write($"док/ф{i}.txt", "новое");
        for (var i = 0; i < 30; i++) network.Write($"док/ф{i}.txt", "старое-другой-длины");

        var args = Args(local, network, ["док"]);
        var both = await Task.WhenAll(_b.Sync(args), _b.Sync(args));

        Assert.Equal(1, both.Count(r => r.Error != null));
        Assert.Equal(0, both.Single(r => r.Error == null).Unrecoverable);
        Assert.Equal(Snapshot(local.Root), Snapshot(network.Root));
        Assert.False(Directory.Exists(network.P(".sgundo")));
    }

    [Fact]
    public async Task остановка_посреди_работы_возвращает_приёмник_как_было()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        for (var i = 0; i < 150; i++) local.Write($"док/новый{i}.txt", "новое");
        for (var i = 0; i < 150; i++) network.Write($"док/старый{i}.txt", "старое");

        var before = Snapshot(network.Root);
        // Останавливаем с первым же отчётом о ходе работы - так остановка гарантированно
        // приходит посреди, а не после (в JS - таймер на 10 мс).
        var progress = new SyncProgressProbe(() => _b.CancelSync());
        var res = await _b.Sync(Args(local, network, ["док"]), progress);

        Assert.True(res.Cancelled);
        Assert.Equal(before, Snapshot(network.Root));
        Assert.False(Directory.Exists(network.P(".sgundo")));
    }

    private sealed class SyncProgressProbe(Action onFirst) : IProgress<SyncProgress>
    {
        private int _n;
        public void Report(SyncProgress value)
        {
            if (Interlocked.Increment(ref _n) == 1) onFirst();
        }
    }

    // Оборвавшийся запуск мог идти в другую сторону - оригиналы лежат в том корне,
    // который сейчас источник.
    [Fact]
    public async Task брошенные_оригиналы_разбираются_на_обеих_сторонах()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/общий.txt", "одинаково");
        network.Write("док/общий.txt", "одинаково");
        local.Write(".sgundo/док/брошенный.txt", "вернуть на место");

        await _b.Sync(Args(local, network, ["док"]));

        Assert.True(File.Exists(local.P("док/брошенный.txt")));
        Assert.True(File.Exists(network.P("док/брошенный.txt")));
    }

    [Fact]
    public async Task конфликт_папка_против_файла_разрешается_в_пользу_источника()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/узел", "на источнике это файл");
        network.Write("док/узел/внутри.txt", "на приёмнике это папка");

        await _b.Sync(Args(local, network, ["док"]));

        Assert.True(File.Exists(network.P("док/узел")));
        Assert.Equal("на источнике это файл", File.ReadAllText(network.P("док/узел")));
    }

    [Fact]
    public async Task история_перечисляет_ровно_то_что_обещает_сводка_удаления_первыми()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        for (var i = 0; i < 5; i++) local.Write($"д/новый{i}.txt", "x");
        for (var i = 0; i < 3; i++) network.Write($"д/лишний{i}.txt", "y");

        await _b.Sync(Args(local, network, ["д"]));
        var run = (await _b.GetHistory())[0];

        var t = run.Totals!;
        Assert.Equal(t.Move + t.Copy + t.Overwrite + t.Trash, run.Files!.Count);
        Assert.Equal("trash", run.Files[0].Action);
    }

    [Fact]
    public async Task битые_файлы_состояния_не_роняют_приложение()
    {
        File.WriteAllText(Path.Join(_userData.Root, "settings.json"), "{это не json");
        var s = await _b.GetSettings();
        Assert.Null(s.LocalPath);
        Assert.Null(s.NetworkPath);

        File.WriteAllText(Path.Join(_userData.Root, "history.json"), "{\"не\":\"массив\"}");
        Assert.Empty(await _b.GetHistory());
    }

    [Fact]
    public async Task probe_различает_доступную_и_недоступную_сторону()
    {
        using var local = new TempDir();
        var r = await _b.Probe(local.Root, local.P("нет"));
        Assert.True(r.LocalOk);
        Assert.False(r.NetworkOk);

        var пусто = await _b.Probe("", "");
        Assert.False(пусто.LocalOk);
        Assert.False(пусто.NetworkOk);
    }

    [Fact]
    public async Task файл_на_месте_папки_предка_не_срывает_синхронизацию_выбранной_ветки()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("a/b/нужный.txt", "нужен");
        local.Write("другое/ok.txt", "ok");
        network.Write("a", "на приёмнике это файл");

        var args = Args(local, network, ["a/b", "другое"]);
        var pv = await _b.Preview(args);
        Assert.Equal(1, pv.Totals!.Trash);

        var res = await _b.Sync(args);
        Assert.Equal(0, res.Failures);
        Assert.Equal("нужен", File.ReadAllText(network.P("a/b/нужный.txt")));

        var again = await _b.Preview(args);
        Assert.Equal(0, again.Totals!.Total);
    }

    // Предпросмотр обязан разбирать служебную папку так же, как запуск: иначе он видит
    // дыру на месте отложенного файла и обещает скопировать его заново.
    [Fact]
    public async Task предпросмотр_разбирает_служебную_папку_так_же_как_это_делает_запуск()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/важное.txt", "ценные данные");
        network.Write("док/важное.txt", "ценные данные");
        File.SetLastWriteTimeUtc(network.P("док/важное.txt"), File.GetLastWriteTimeUtc(local.P("док/важное.txt")));
        network.Mkdir(".sgundo/док");
        File.Move(network.P("док/важное.txt"), network.P(".sgundo/док/важное.txt"));

        var args = Args(local, network, ["док"]);
        var pv = await _b.Preview(args);
        Assert.Equal(0, pv.Totals!.Total);
        Assert.Equal("ценные данные", File.ReadAllText(network.P("док/важное.txt")));

        var res = await _b.Sync(args);
        Assert.Equal(pv.Totals.Total, res.Total);
    }

    // История перечисляет сделанное, а не задуманное: путь перемещения лежит в To.
    [Fact]
    public async Task провалившееся_перемещение_не_попадает_в_историю_как_сделанное()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/новая-папка/файл.txt", "один и тот же текст");
        network.Write("док/старая-папка/файл.txt", "один и тот же текст");
        var когда = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Local);
        File.SetLastWriteTime(local.P("док/новая-папка/файл.txt"), когда);
        File.SetLastWriteTime(network.P("док/старая-папка/файл.txt"), когда);

        var args = Args(local, network, ["док"]);
        var pv = await _b.Preview(args);
        Assert.Equal(1, pv.Totals!.Move);

        // Место назначения занимает непустая папка - уже после предпросмотра.
        network.Write("док/новая-папка/файл.txt/чужое", "занято");

        await _b.ClearHistory();
        var res = await _b.Sync(args);
        Assert.Equal(1, res.Failures);

        var запуск = (await _b.GetHistory())[0];
        Assert.Empty(запуск.Files!);
    }

    [Fact]
    public async Task сеть_локально_сводит_стороны_так_же_как_и_обратное_направление()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        network.Write("док/новый.txt", "новое");
        local.Write("док/лишний.txt", "убрать");

        var args = Args(local, network, ["док"], null, "toLocal");
        var pv = await _b.Preview(args);
        Assert.Equal(1, pv.Totals!.Copy);
        Assert.Equal(1, pv.Totals.Trash);

        var res = await _b.Sync(args);
        Assert.Equal(0, res.Failures);
        Assert.Equal(Snapshot(local.Root), Snapshot(network.Root));
    }

    // Нового в C#: нечитаемый корень - недоступная сторона, а не пустая (denied.test.js,
    // тест про list-folders): одна осечка чтения уносила бы весь выбор пользователя.
    [Fact]
    public async Task нечитаемый_корень_это_недоступная_сторона_а_не_пустая()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/а.txt", "a");
        network.Write("док/а.txt", "a");

        var ok = await _b.ListFolders(local.Root, network.Root, "");
        Assert.True(ok.LocalOk);
        Assert.Single(ok.Items);

        using var deny = new DeniedTests.Deny(local.Root);
        var denied = await _b.ListFolders(local.Root, network.Root, "", force: true);
        Assert.False(denied.LocalOk);
        Assert.True(denied.NetworkOk);
    }

    // Нового в C#: срок жизни. Скан и индекс обхода подменяют диск, значит стареют:
    // окно, открытое с утра, к вечеру описывает диск, которого уже нет.
    [Fact]
    public async Task индекс_обхода_старше_15_минут_не_подменяет_живой_диск()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/был.txt", "1");
        var t0 = DateTime.UtcNow;
        _b.Now = () => t0;
        await _b.StartCrawl(local.Root, network.Root, false, new RecordingSink());
        local.Write("док/появился.txt", "2"); // после обхода

        var args = Args(local, network, ["док"]);
        _b.Now = () => t0.AddMinutes(1);
        Assert.Equal(1, (await _b.Preview(args)).Totals!.Copy); // свежий индекс - нового не видно
        _b.Now = () => t0.AddMinutes(16);
        Assert.Equal(2, (await _b.Preview(args)).Totals!.Copy); // просроченный - живой скан
    }

    [Fact]
    public async Task скан_старше_15_минут_перечитывается()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/был.txt", "1");
        var t0 = DateTime.UtcNow;
        _b.Now = () => t0;
        var args = Args(local, network, ["док"]);
        Assert.Equal(1, (await _b.Preview(args)).Totals!.Copy);
        local.Write("док/появился.txt", "2");

        _b.Now = () => t0.AddMinutes(1);
        Assert.Equal(1, (await _b.Preview(args)).Totals!.Copy); // скан из кеша
        _b.Now = () => t0.AddMinutes(16);
        Assert.Equal(2, (await _b.Preview(args)).Totals!.Copy); // просрочен - заново
    }

    // «Обновить» сбрасывает и сканы, и индекс: данные под руками устарели.
    [Fact]
    public async Task обновить_сбрасывает_кеш_сканов()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("док/был.txt", "1");
        var args = Args(local, network, ["док"]);
        Assert.Equal(1, (await _b.Preview(args)).Totals!.Copy);
        local.Write("док/появился.txt", "2");
        Assert.Equal(1, (await _b.Preview(args)).Totals!.Copy);
        await _b.ListFolders(local.Root, network.Root, "", force: true);
        Assert.Equal(2, (await _b.Preview(args)).Totals!.Copy);
    }

    // ---- История: пределы хранения (history.test.js) ----

    private static object RunRecord(int i, int fileCount = 3) => new
    {
        time = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
        direction = "toNetwork",
        localPath = @"C:\local",
        networkPath = @"\\server\share",
        totals = new { move = 0, copy = fileCount, overwrite = 0, trash = 0, dirs = 0 },
        permanentDeletes = 0,
        failures = 0,
        files = Enumerable.Range(0, fileCount).Select(k => new { action = "copy", path = $"run{i}/f{k}.txt" }),
        filesTruncated = 0,
    };

    private string HistoryPath => Path.Join(_userData.Root, "history.json");

    [Fact]
    public async Task история_отдаёт_поимённые_списки_только_у_последних_запусков()
    {
        File.WriteAllText(HistoryPath, JsonSerializer.Serialize(Enumerable.Range(0, 40).Select(i => RunRecord(i))));

        var got = await _b.GetHistory();

        Assert.Equal(40, got.Count);
        Assert.NotNull(got[0].Files);
        Assert.NotNull(got[19].Files);
        Assert.Null(got[20].Files);
        Assert.True(got[20].DetailsDropped);
        Assert.Equal(3, got[20].FileCount);
        Assert.NotNull(got[39].Totals);
    }

    [Fact]
    public async Task запись_новой_синхронизации_срезает_перечни_у_старых_а_не_копит_их()
    {
        using var local = new TempDir();
        using var network = new TempDir();
        local.Write("ветка/a.txt", "a");
        File.WriteAllText(HistoryPath, JsonSerializer.Serialize(Enumerable.Range(0, 30).Select(i => RunRecord(i, 5))));

        await _b.Sync(Args(local, network, ["ветка"]));

        using var onDisk = JsonDocument.Parse(File.ReadAllText(HistoryPath));
        var runs = onDisk.RootElement.EnumerateArray().ToList();
        Assert.Equal(31, runs.Count);
        Assert.True(runs[0].TryGetProperty("files", out _));
        Assert.Equal(20, runs.Count(r => r.TryGetProperty("files", out _)));
        // Незнакомое поле старых записей (permanentDeletes) переживает перезапись.
        Assert.True(runs[1].TryGetProperty("permanentDeletes", out _));
    }

    [Fact]
    public async Task мусор_внутри_массива_истории_отсеивается_на_чтении()
    {
        File.WriteAllText(HistoryPath, "[null," + JsonSerializer.Serialize(RunRecord(0)) + ",5,\"строка\",[\"массив\"]," + JsonSerializer.Serialize(RunRecord(1)) + "]");

        var got = await _b.GetHistory();

        Assert.Equal(2, got.Count);
        Assert.NotNull(got[0].Totals);
    }
}
