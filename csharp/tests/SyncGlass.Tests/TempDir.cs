namespace SyncGlass.Tests;

// Временная папка на тест, как fs.mkdtemp в JS-тестах. Своя папка теста в %TEMP%,
// поэтому убирается напрямую, а не через Корзину.
internal sealed class TempDir : IDisposable
{
    public string Root { get; } = Directory.CreateTempSubdirectory("sgtest-").FullName;

    public string P(string rel) => Path.Join(Root, rel);

    public void Write(string rel, string text, DateTime? mtimeUtc = null) => WriteBytes(rel, System.Text.Encoding.UTF8.GetBytes(text), mtimeUtc);

    public void WriteBytes(string rel, byte[] data, DateTime? mtimeUtc = null)
    {
        var p = P(rel);
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        File.WriteAllBytes(p, data);
        if (mtimeUtc is { } t) File.SetLastWriteTimeUtc(p, t);
    }

    public void Mkdir(string rel) => Directory.CreateDirectory(P(rel));

    public void Dispose()
    {
        try { Directory.Delete(Root, true); } catch { /* антивирус держит файл - не беда, это %TEMP% */ }
    }
}
