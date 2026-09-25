namespace SyncGlass.Tests;

// Образцы договора двух версий лежат в fixtures/ в корне репозитория, их пишет
// tools/make-fixtures.js. Ищем папку вверх от сборки тестов.
internal static class Fixtures
{
    public static string Dir { get; } = Find();

    private static string Find()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            if (Directory.Exists(Path.Combine(d.FullName, "fixtures")) &&
                Directory.Exists(Path.Combine(d.FullName, "csharp")))
                return Path.Combine(d.FullName, "fixtures");
        }
        throw new DirectoryNotFoundException("fixtures/ не найдена выше " + AppContext.BaseDirectory);
    }

    public static string Read(string name) => File.ReadAllText(Path.Combine(Dir, name));
}
