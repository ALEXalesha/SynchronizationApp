using System.Text.Json;
using SyncGlass.Core;

namespace SyncGlass.Tests;

// Договор двух версий: C# обязан вести себя как JS там, где их пути сходятся -
// в общих файлах и в решениях «один это файл или два».
public class ContractTests
{
    private sealed record CiSample(string s, string key);

    // Ключ сравнения путей обязан совпадать с JS до символа: по нему обе версии
    // решают, один это файл или два, и по нему же раскладываются размеры в дереве.
    [Fact]
    public void CiKey_совпадает_с_toLowerCase_из_Node()
    {
        var samples = JsonSerializer.Deserialize<CiSample[]>(Fixtures.Read("cikey.json"))!;
        Assert.True(samples.Length > 10);
        var wrong = samples
            .Where(x => Paths.CiKey(x.s) != x.key)
            .Select(x => $"{x.s}: JS '{x.key}' ({Codes(x.key)}), C# '{Paths.CiKey(x.s)}' ({Codes(Paths.CiKey(x.s))})")
            .ToList();
        Assert.True(wrong.Count == 0, string.Join("\n", wrong));
    }

    private static string Codes(string s) => string.Join(" ", s.Select(c => ((int)c).ToString("X4")));

    // Папка данных с образцом внутри - как если бы Electron только что закрылся.
    private static (TempDir Dir, Core.Main.Backend B) WithFixture(string fixture, string asName)
    {
        var t = new TempDir();
        File.Copy(System.IO.Path.Join(Fixtures.Dir, fixture), t.P(asName));
        return (t, new Core.Main.Backend(t.Root));
    }

    [Fact]
    public async Task настройки_записанные_Electron_читаются_и_переживают_перезапись_без_потерь()
    {
        var (t, b) = WithFixture("settings.json", "settings.json");
        using var _ = t;
        var s = await b.GetSettings();
        Assert.Equal(@"C:\Users\Пример\Документы", s.LocalPath);
        Assert.Equal(@"\\Сервер\Общая папка", s.NetworkPath);
        Assert.Equal("toLocal", s.Direction);
        Assert.Equal("date", s.Sort);
        Assert.Equal("capped", s.SizeMode);

        await b.SaveSettings(s);
        var js = System.Text.Json.Nodes.JsonNode.Parse(Fixtures.Read("settings.json"));
        var cs = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(t.P("settings.json")));
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(js, cs), "C# переписал настройки не в том виде, в каком их пишет Electron");
        // Русские буквы - как есть, как у JSON.stringify.
        Assert.Contains("Пример", File.ReadAllText(t.P("settings.json")));
    }

    [Fact]
    public async Task история_записанная_Electron_читается_и_переживает_перезапись_без_потерь()
    {
        var (t, b) = WithFixture("history.json", "history.json");
        using var _ = t;
        var runs = await b.GetHistory();
        var run = Assert.Single(runs);
        Assert.Equal("toNetwork", run.Direction);
        Assert.Equal(4, run.Files!.Count);
        Assert.Equal("trash", run.Files[0].Action);
        Assert.Equal(run.Totals!.Copy + run.Totals.Trash + run.Totals.Move + run.Totals.Overwrite, run.Files.Count);

        // Перезапись C# (добавить запуск) сохраняет старую запись поле в поле.
        await b.History.Append(new Core.Main.HistoryRun { Time = "2026-09-26T00:00:00.000Z", Direction = "toLocal", Totals = new(), Files = [] });
        var js = System.Text.Json.Nodes.JsonNode.Parse(Fixtures.Read("history.json"))!.AsArray()[0];
        var cs = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(t.P("history.json")))!.AsArray()[1];
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(js, cs), "C# переписал запись истории не в том виде, в каком её пишет Electron");
    }

    private sealed record CacheName(string localPath, string networkPath, string file);

    // Имя кеша размеров - md5 пары путей. Разойдись оно - обе версии обходили бы дерево
    // заново вместо мгновенного показа.
    [Fact]
    public async Task кеш_размеров_Electron_находится_по_тому_же_имени_и_читается_целиком()
    {
        var name = JsonSerializer.Deserialize<CacheName>(Fixtures.Read("sizecache-name.json"))!;
        using var t = new TempDir();
        var b = new Core.Main.Backend(t.Root);
        Assert.Equal(name.file, System.IO.Path.GetFileName(b.SizeCache.FileFor(name.localPath, name.networkPath)));

        File.Copy(System.IO.Path.Join(Fixtures.Dir, "sizecache.json"), t.P(name.file));
        var entries = await b.SizeCache.Load(name.localPath, name.networkPath);
        var js = System.Text.Json.Nodes.JsonNode.Parse(Fixtures.Read("sizecache.json"))!["entries"]!.AsArray();
        Assert.NotNull(entries);
        Assert.Equal(js.Count, entries!.Count);

        // И записанный C# кеш - того же вида, что у Electron.
        await b.SizeCache.Save(name.localPath, name.networkPath, entries);
        var cs = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(t.P(name.file)));
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(Fixtures.Read("sizecache.json")), cs));
    }
}
