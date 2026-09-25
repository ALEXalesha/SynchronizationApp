using SyncGlass.Core;
using static SyncGlass.Core.WindowState;

namespace SyncGlass.Tests;

// Перенос test/window-state.test.js. Главное - не «запомнило ли», а «что бы ни лежало
// в файле, окно откроется там, где его видно и можно взять за заголовок».
public class WindowStateTests
{
    private static readonly Options Opts = new(900, 600, 900, 600);
    private static readonly Area FullHd = new(0, 0, 1920, 1040);
    private static readonly Area Right = new(1920, 0, 2560, 1400);

    [Fact]
    public void без_файла_по_центру_размер_постоянный()
        => Assert.Equal(new Placement(null, null, 900, 600, false), Restore(null, [FullHd], Opts));

    [Fact]
    public void окно_на_экране_открывается_ровно_там_где_было()
        => Assert.Equal(new Placement(300, 200, 900, 600, false), Restore(new Saved(300, 200, 900, 600, false), [FullHd], Opts));

    [Fact]
    public void второй_монитор_отключили_окно_по_центру_основного()
    {
        var saved = new Saved(2500, 100, 900, 600, false);
        Assert.Equal(new Placement(2500, 100, 900, 600, false), Restore(saved, [FullHd, Right], Opts));
        Assert.Equal(new Placement(null, null, 900, 600, false), Restore(saved, [FullHd], Opts));
    }

    [Fact]
    public void окно_заехавшее_за_край_придвигается_к_экрану_целиком()
        => Assert.Equal(new Placement(1020, 440, 900, 600, false), Restore(new Saved(1800, 900, 900, 600, false), [FullHd], Opts));

    // Генератор mulberry32 из JS-теста; мусор - нечисла, огромные и отрицательные числа.
    private sealed class Rng(uint seed)
    {
        private uint _s = seed;
        public double Next()
        {
            _s += 0x6D2B79F5;
            var t = _s;
            t = unchecked((t ^ (t >> 15)) * (t | 1));
            t ^= t + unchecked((t ^ (t >> 7)) * (t | 61));
            return (t ^ (t >> 14)) / 4294967296.0;
        }
        public int Int(int a, int b) => a + (int)Math.Floor(Next() * (b - a + 1));
    }

    [Fact]
    public void что_бы_ни_лежало_в_файле_заголовок_на_экране_а_повтор_ничего_не_меняет()
    {
        for (uint seed = 1; seed <= 3000; seed++)
        {
            var r = new Rng(seed);
            double? V()
            {
                return r.Int(0, 4) switch
                {
                    0 => null,
                    1 => double.NaN,
                    2 => null, // строка в файле читается как не число
                    3 => r.Next() * 1e5 - 5e4,
                    _ => r.Int(-20000, 20000),
                };
            }
            Saved? junk = r.Next() < 0.2 ? null : new Saved(V(), V(), V(), V(), false);
            var screens = new List<Area>();
            var x = r.Int(-5000, 5000);
            for (var i = r.Int(1, 3); i > 0; i--)
            {
                var a = new Area(x, r.Int(-3000, 3000), r.Int(1024, 4000), r.Int(700, 2500));
                screens.Add(a);
                x += (int)a.Width;
            }
            var w = Restore(junk, screens, Opts);
            var ctx = "зерно " + seed;
            Assert.True(w.Width >= 900 && w.Height >= 600, ctx);
            Assert.True((w.X == null) == (w.Y == null), ctx);
            if (w.X is { } wx && w.Y is { } wy)
            {
                Assert.True(screens.Any(a => wx >= a.X && wy >= a.Y && wx < a.X + a.Width && wy + GripHeight <= a.Y + a.Height), ctx);
                Assert.Equal(w, Restore(new Saved(w.X, w.Y, w.Width, w.Height, w.Maximized), screens, Opts));
            }
        }
    }

    [Fact]
    public void обрезанный_или_пустой_файл_окно_по_умолчанию_запись_не_оставляет_tmp()
    {
        using var t = new TempDir();
        var file = t.P("window-state.json");
        Assert.True(Save(file, new Placement(5, 6, 900, 600, false)));
        Assert.Equal(new Saved(5, 6, 900, 600, false), Load(file));
        Assert.False(File.Exists(file + ".tmp"));
        foreach (var text in new[] { "", "{\"x\": 1", "null" })
        {
            File.WriteAllText(file, text);
            Assert.Equal(new Placement(null, null, 900, 600, false), Restore(Load(file), [FullHd], Opts));
        }
    }

    // Нового в C#: файл общий с Electron - то, что записал он, читается здесь, и наоборот.
    [Fact]
    public void файл_Electron_читается_и_запись_в_том_же_виде()
    {
        using var t = new TempDir();
        var file = t.P("window-state.json");
        File.WriteAllText(file, "{\"x\":510,\"y\":240,\"width\":900,\"height\":600,\"maximized\":false}");
        Assert.Equal(new Saved(510, 240, 900, 600, false), Load(file));
        Save(file, new Placement(510, 240, 900, 600, false));
        Assert.Equal("{\"x\":510,\"y\":240,\"width\":900,\"height\":600,\"maximized\":false}", File.ReadAllText(file));
    }

    // Math.round из JS: -0.5 → -0, 2.5 → 3 (а не 2, как у Math.Round по умолчанию).
    [Fact]
    public void округление_как_в_JS()
        => Assert.Equal(new Placement(null, null, 901, 601, false), Restore(new Saved(null, null, 900.5, 600.5, false), [FullHd], new Options(900, 600, 900, 600)));
}
