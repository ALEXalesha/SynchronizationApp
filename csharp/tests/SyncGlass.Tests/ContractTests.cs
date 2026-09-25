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
}
