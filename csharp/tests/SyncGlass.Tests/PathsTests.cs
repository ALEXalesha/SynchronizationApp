using SyncGlass.Core;

namespace SyncGlass.Tests;

// Перенос test/paths.test.js.
public class PathsTests
{
    private static readonly string Sep = Path.DirectorySeparatorChar.ToString();

    // Корни синхронизации не должны пересекаться: копирование папки внутрь самой
    // себя разрастается на ходу и никогда не сходится.
    [Fact]
    public void rootsOverlap_ловит_вложенность_корней_в_обе_стороны()
    {
        var @base = Path.GetFullPath("data");
        Assert.True(Paths.RootsOverlap(@base, Path.Join(@base, "backup")));
        Assert.True(Paths.RootsOverlap(Path.Join(@base, "backup"), @base));
    }

    [Fact]
    public void rootsOverlap_считает_одну_и_ту_же_папку_пересечением()
    {
        var @base = Path.GetFullPath("data");
        Assert.True(Paths.RootsOverlap(@base, @base));
        Assert.True(Paths.RootsOverlap(@base, @base + Sep));
    }

    [Fact]
    public void rootsOverlap_пропускает_соседние_папки_и_общий_префикс_имени()
    {
        var a = Path.GetFullPath("data");
        Assert.False(Paths.RootsOverlap(a, Path.GetFullPath("pics")));
        // 'data2' начинается на 'data', но подпапкой не является.
        Assert.False(Paths.RootsOverlap(a, Path.GetFullPath("data2")));
    }

    // Нового в C#: path.resolve срезает хвостовой разделитель, GetFullPath - нет.
    // Корень диска при этом остаётся корнем: 'C:\' внутри себя содержит всё.
    [Fact]
    public void rootsOverlap_корень_диска_содержит_свои_папки()
    {
        var root = Path.GetPathRoot(Path.GetFullPath("data"))!;
        Assert.True(Paths.RootsOverlap(root, Path.GetFullPath("data")));
        Assert.True(Paths.RootsOverlap(Path.GetFullPath("data"), root));
    }

    // RootsOverlap спрашивает в обе стороны и этим маскирует хвостовой разделитель;
    // IsInside сам по себе обязан считать 'data' и 'data\' одной папкой, как path.resolve.
    [Fact]
    public void isInside_папка_со_слешем_на_конце_та_же_папка()
    {
        var @base = Path.GetFullPath("data");
        Assert.True(Paths.IsInside(@base, @base + Sep));
        Assert.True(Paths.IsInside(@base + Sep, @base));
    }

    [Fact]
    public void rootsOverlap_без_учёта_регистра()
    {
        var a = Path.GetFullPath("Data");
        Assert.True(Paths.RootsOverlap(a, Path.GetFullPath("dATA") + Sep + "x"));
    }
}
