using System.Text.Json;
using System.Text.RegularExpressions;

namespace SyncGlass.Tests;

// Закон выпуска: у двух версий один номер (решение Алексея 26.09.2026), и он записан во
// всех местах, откуда его берут сборки: package.json (Electron), SyncGlass.Wpf.csproj
// (C#), установщик C#. У выпуска есть короткое описание изменений - docs/release-notes.
// В Paint Pro номер однажды разъехался между csproj и установщиком: установщик вышел
// с чужой версией.
public class ReleaseTests
{
    private static readonly string Root = Path.GetDirectoryName(Fixtures.Dir)!;

    private static string Electron()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "package.json")));
        return doc.RootElement.GetProperty("version").GetString()!;
    }

    private static string Match(string file, string pattern)
    {
        var m = Regex.Match(File.ReadAllText(Path.Combine(Root, file)), pattern);
        Assert.True(m.Success, $"в {file} нет номера версии ({pattern})");
        return m.Groups[1].Value;
    }

    [Fact]
    public void номер_версии_один_на_обе_версии_и_установщик()
    {
        var electron = Electron();
        Assert.Equal(electron, Match("csharp/src/SyncGlass.Wpf/SyncGlass.Wpf.csproj", @"<Version>([\d.]+)</Version>"));
        Assert.Equal(electron, Match("csharp/installer/SyncGlass.iss", @"#define MyAppVersion ""([\d.]+)"""));
        Assert.Equal(electron, Match("package-lock.json", @"""version"": ""([\d.]+)"""));
    }

    [Fact]
    public void у_выпуска_есть_заметки_на_двух_языках()
    {
        var file = Path.Combine(Root, "docs", "release-notes", $"v{Electron()}.md");
        Assert.True(File.Exists(file), "нет " + file);
        var text = File.ReadAllText(file);
        Assert.Matches("[A-Za-z]{4,}", text);
        Assert.Matches("[А-Яа-яЁё]{4,}", text);
    }
}
