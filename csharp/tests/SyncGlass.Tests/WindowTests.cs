using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using SyncGlass.Core;
using SyncGlass.Core.Main;
using SyncGlass.Ui;
using SyncGlass.Wpf;

namespace SyncGlass.Tests;

// Настоящее окно WPF в тестах: одно приложение на процесс, свой поток STA со своим
// диспетчером (WPF не терпит второго Application в том же домене).
internal static class WpfHost
{
    private static readonly Lazy<Dispatcher> Ui = new(() =>
    {
        Dispatcher? d = null;
        using var ready = new ManualResetEventSlim();
        var t = new Thread(() =>
        {
            var app = new App();
            app.InitializeComponent(); // стили Glass.xaml
            d = Dispatcher.CurrentDispatcher;
            ready.Set();
            Dispatcher.Run();
        }) { IsBackground = true };
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        ready.Wait();
        return d!;
    });

    public static Task Run(Func<Task> body) => Ui.Value.InvokeAsync(body).Task.Unwrap();
}

[Collection("Окно")] // окно одно на процесс - тесты окна по очереди
public class WindowTests
{
    private static ListItem Dto(string relPath, bool isDir = true, bool local = true, bool network = true)
        => new(relPath.Split('/')[^1], relPath, isDir, local, network, 0);

    private static FakeApi DemoApi() => new()
    {
        SettingsAnswer = new AppSettings { LocalPath = @"C:\Ноутбук\Проекты", NetworkPath = @"\\ПК\Проекты", Direction = "toNetwork", Sort = "name", SizeMode = "off" },
        List = rel => rel == "Курсовая"
            ? new ListResult([Dto("Курсовая/глава 1.docx", false), Dto("Курсовая/лишнее.txt", false, local: false)], true, true)
            : new ListResult([Dto("Курсовая"), Dto("Сайт"), Dto("заметки.md", false)], true, true),
        PreviewAnswer = new PreviewResult([new FolderCount("Курсовая", new Summary(0, 1, 0, 1, 0, 0, 2))], new Summary(0, 1, 0, 1, 0, 0, 2), ["закрыто"], 1),
        HistoryAnswer = [new HistoryRun { Time = "2026-09-26T10:00:00.000Z", Direction = "toNetwork", Totals = new HistoryTotals { Copy = 1, Trash = 1 }, Failures = 1, Files = [new("copy", "Курсовая/глава 1.docx")] }],
    };

    // Яркость цвета поверх тёмного фона окна (#1C2128), 0 - чёрный, 1 - белый.
    private static double Luminance(Color c)
    {
        double Mix(byte fg, byte bg) => (fg * c.A + bg * (255 - c.A)) / 255.0 / 255.0;
        return 0.2126 * Mix(c.R, 0x1C) + 0.7152 * Mix(c.G, 0x21) + 0.0722 * Mix(c.B, 0x28);
    }

    private static IEnumerable<DependencyObject> Tree(DependencyObject root)
    {
        var stack = new Stack<DependencyObject>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            yield return d;
            for (var i = VisualTreeHelper.GetChildrenCount(d) - 1; i >= 0; i--) stack.Push(VisualTreeHelper.GetChild(d, i));
        }
    }

    // Закон: на тёмном окне нет тёмного текста - ни в дереве, ни в предпросмотре, ни
    // в истории. Нашёл Алексей на снимке 26.09.2026: имена папок в дереве были чёрными -
    // список (ListBox) берёт цвет текста из светлой системной темы, если его не задать.
    // Закон спрашивает не одно место, а всё, что видно на экране.
    [Fact]
    public async Task на_тёмном_окне_нет_тёмного_текста()
    {
        var тёмные = new List<string>();
        var проверено = 0;
        await WpfHost.Run(async () =>
        {
            var api = DemoApi();
            var vm = new MainViewModel(api);
            var win = new MainWindow { PlacementFile = null, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -3000, Top = 0 };
            win.Attach(vm, null);
            win.Show();
            try
            {
                for (var i = 0; i < 100 && vm.Rows.Count < 3; i++) await Task.Delay(20);
                await vm.ToggleExpand(vm.Roots.Single(n => n.Name == "Курсовая"));
                vm.ToggleCheck(vm.Roots.Single(n => n.Name == "Курсовая"));
                await vm.Preview.Open();
                await vm.History.Open();
                vm.History.Toggle(vm.History.Runs[0]);
                win.UpdateLayout();
                await Task.Delay(50);
                win.UpdateLayout();

                foreach (var tb in Tree(win).OfType<TextBlock>())
                {
                    if (!tb.IsVisible || string.IsNullOrWhiteSpace(tb.Text)) continue;
                    проверено++;
                    if (tb.Foreground is SolidColorBrush b && Luminance(b.Color) < 0.3)
                        тёмные.Add($"«{tb.Text}» ({b.Color})");
                }
            }
            finally
            {
                win.Close();
            }
        });
        Assert.True(проверено > 30, $"проверено всего {проверено} надписей - окно не наполнилось");
        Assert.True(тёмные.Count == 0, "тёмный текст на тёмном окне: " + string.Join(", ", тёмные.Distinct()));
    }

    // Закон: строка дерева разложена как в Electron (styles.css: .folder-row gap 8px,
    // флажок 16px). Нашлось сравнением кадров 26.09.2026: у флажка без подписи оставался
    // отступ под подпись, флажок занимал 23 px, и имя папки уезжало вправо. И длинный
    // путь внизу окна обрезается многоточием, как text-overflow: ellipsis, а не молча.
    [Fact]
    public async Task строка_дерева_и_поле_пути_как_в_Electron()
    {
        double флажок = 0, отступИмени = 0;
        var обрезка = TextTrimming.None;
        await WpfHost.Run(async () =>
        {
            var api = DemoApi();
            api.SettingsAnswer!.LocalPath = @"C:\Users\Алексей\Documents\очень\длинный\путь\до\папки\с\проектами\и\ещё\глубже";
            var vm = new MainViewModel(api);
            var win = new MainWindow { PlacementFile = null, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -3000, Top = 0 };
            win.Attach(vm, null);
            win.Show();
            try
            {
                for (var i = 0; i < 100 && vm.Rows.Count < 3; i++) await Task.Delay(20);
                win.UpdateLayout();
                var имя = Tree(win).OfType<TextBlock>().First(t => t.Text == "Курсовая" && t.IsVisible);
                var строка = (Panel)VisualTreeHelper.GetParent(имя);
                var box = строка.Children.OfType<CheckBox>().Single();
                флажок = box.ActualWidth;
                отступИмени = имя.TranslatePoint(new Point(), box).X;

                var путь = Tree(win).OfType<TextBlock>().First(t => t.Text == api.SettingsAnswer.LocalPath);
                обрезка = путь.TextTrimming;
            }
            finally
            {
                win.Close();
            }
        });
        Assert.Equal(16, флажок);
        Assert.Equal(16 + 8, отступИмени);
        Assert.Equal(TextTrimming.CharacterEllipsis, обрезка);
    }
    // Закон: раскрытие записи истории на 5000 файлов не вешает окно. Нашёл Алексей
    // 26.09.2026: открыл историю, раскрыл «что перемещено» - окно подвисло. У записи из
    // его настоящей истории 5000 строк (больше история не хранит), а список файлов не был
    // виртуализирован: WPF строил все 5000 строк разом. Меряем, сколько строк создано и
    // сколько длилось раскрытие с раскладкой.
    [Fact]
    public async Task раскрытие_записи_истории_на_5000_файлов_не_вешает_окно()
    {
        var строк = 0;
        var мс = 0.0;
        await WpfHost.Run(async () =>
        {
            var api = DemoApi();
            var files = Enumerable.Range(0, 5000).Select(i => new HistoryFile(i % 7 == 0 ? "move" : "copy", $"Проекты/папка {i / 50}/файл номер {i}.txt")).ToList();
            api.HistoryAnswer = [new HistoryRun { Time = "2026-09-13T15:46:50.703Z", Direction = "toNetwork", Totals = new HistoryTotals { Move = 86, Copy = 132226 }, Files = files, FilesTruncated = 133316 }];
            var vm = new MainViewModel(api);
            var win = new MainWindow { PlacementFile = null, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -3000, Top = 0 };
            win.Attach(vm, null);
            win.Show();
            try
            {
                for (var i = 0; i < 100 && vm.Rows.Count < 3; i++) await Task.Delay(20);
                await vm.History.Open();
                win.UpdateLayout();
                var sw = System.Diagnostics.Stopwatch.StartNew();
                vm.History.Toggle(vm.History.Runs[0]);
                win.UpdateLayout();
                мс = sw.Elapsed.TotalMilliseconds;
                строк = Tree(win).OfType<TextBlock>().Count(t => t.Text.Contains("файл номер"));
            }
            finally
            {
                win.Close();
            }
        });
        Assert.True(строк is > 0 and < 200, $"построено строк файлов: {строк} (видно ~12), раскрытие {мс:F0} мс");
        Assert.True(мс < 250, $"раскрытие с раскладкой: {мс:F0} мс");
    }
    // Закон: открытие истории на 200 записей (больше история не хранит) строит только
    // видимые записи. Замер 26.09.2026: список записей не был виртуализирован - на 26
    // записях Алексея открытие стоило 150 мс, на 200 выросло бы в разы.
    [Fact]
    public async Task открытие_истории_на_200_записей_строит_только_видимые()
    {
        var записей = 0;
        var мс = 0.0;
        await WpfHost.Run(async () =>
        {
            var api = DemoApi();
            api.HistoryAnswer = Enumerable.Range(0, 200).Select(i => new HistoryRun
            {
                Time = "2026-09-13T15:46:50.703Z", Direction = "toNetwork", Totals = new HistoryTotals { Copy = i + 1, Trash = i % 3 }, Failures = i % 5,
                Files = [new("copy", $"файл {i}.txt")],
            }).ToList();
            var vm = new MainViewModel(api);
            var win = new MainWindow { PlacementFile = null, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -3000, Top = 0 };
            win.Attach(vm, null);
            win.Show();
            try
            {
                for (var i = 0; i < 100 && vm.Rows.Count < 3; i++) await Task.Delay(20);
                await vm.History.Open();
                vm.History.Close();
                win.UpdateLayout();
                var sw = System.Diagnostics.Stopwatch.StartNew();
                await vm.History.Open();
                win.UpdateLayout();
                мс = sw.Elapsed.TotalMilliseconds;
                записей = Tree(win).OfType<ListBoxItem>().Count(x => x.DataContext is HistoryRunRow);
            }
            finally
            {
                win.Close();
            }
        });
        Assert.True(записей is > 0 and < 40, $"построено записей: {записей} из 200, открытие {мс:F0} мс");
        Assert.True(мс < 150, $"открытие истории: {мс:F0} мс");
    }

    // Закон: история читается не в потоке окна и без лишнего мусора. Замер 26.09.2026 на
    // настоящем history.json Алексея (2,2 МБ, 20 записей по 5000 файлов): разбор через
    // JsonNode шёл в потоке окна после чтения файла, выделял 161 МБ и держал окно до 0,8 с.
    [Fact]
    public async Task история_читается_не_в_потоке_окна()
    {
        using var data = new TempDir();
        var runs = Enumerable.Range(0, 20).Select(r => new HistoryRun
        {
            Time = "2026-09-13T15:46:50.703Z", Direction = "toNetwork", Totals = new HistoryTotals { Copy = 5000 },
            Files = Enumerable.Range(0, 5000).Select(i => new HistoryFile("copy", $"Проекты/папка {i / 50}/файл номер {i}.txt")).ToList(),
        }).ToList();
        File.WriteAllText(Path.Join(data.Root, "history.json"), System.Text.Json.JsonSerializer.Serialize(runs, Store.Compact));
        var размер = new FileInfo(Path.Join(data.Root, "history.json")).Length;
        var backend = new Backend(data.Root);

        long вОкне = 0;
        var прочитано = 0;
        await WpfHost.Run(async () =>
        {
            await backend.GetHistory(); // первый раз - разогрев: JIT и разбор типов
            var a = GC.GetAllocatedBytesForCurrentThread();
            var list = await backend.GetHistory();
            вОкне = GC.GetAllocatedBytesForCurrentThread() - a;
            прочитано = list.Sum(r => r.Files?.Count ?? 0);
        });
        Assert.Equal(20 * 5000, прочитано);
        Assert.True(вОкне < 1 << 20, $"в потоке окна выделено {вОкне / 1048576.0:F1} МБ");

        // Сам разбор - на своём потоке, счётчиком этого потока (счётчик процесса ловил бы
        // соседние тесты - так уже падал закон кеша в CI).
        backend.History.LoadSync();
        var b = GC.GetAllocatedBytesForCurrentThread();
        backend.History.LoadSync();
        var всего = GC.GetAllocatedBytesForCurrentThread() - b;
        Assert.True(всего < 5 * размер, $"разбор выделил {всего / 1048576.0:F0} МБ на файл {размер / 1048576.0:F1} МБ");
    }

    // Флажок WPF и флажок Electron, увеличенные в 4 раза: белые точки галочки (или
    // черты «частично») - маска; сравниваем пересечение масок и центр. Эталоны в look/
    // сняты 26.09.2026 с Electron (styles.css, webContents.setZoomFactor(4), offscreen).
    // Нашёл Алексей: «галочки криво» - WPF рисовал ломаную из своих координат, с разными
    // плечами и со сдвигом на толщину рамки, а Electron - повёрнутый уголок 4x8.
    private static bool[,] WhiteMask(BitmapSource src) => Mask(src, (b, g, r) => Math.Min(b, Math.Min(g, r)) > 200);

    // Синий цвет выбора (#5b7fa6) - сам квадрат включённого флажка.
    private static bool[,] AccentMask(BitmapSource src) => Mask(src, (b, g, r) => Math.Abs(b - 166) < 20 && r < 120);

    private static bool[,] Mask(BitmapSource src, Func<byte, byte, byte, bool> test)
    {
        var w = src.PixelWidth; var h = src.PixelHeight;
        var conv = new FormatConvertedBitmap(src, PixelFormats.Bgra32, null, 0);
        var px = new byte[w * h * 4];
        conv.CopyPixels(px, w * 4, 0);
        var mask = new bool[w, h];
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                var i = (y * w + x) * 4;
                mask[x, y] = test(px[i], px[i + 1], px[i + 2]);
            }
        return mask;
    }

    private static (double iou, double dx, double dy) Compare(bool[,] a, bool[,] b)
    {
        int inter = 0, union = 0; double ax = 0, ay = 0, bx = 0, by = 0; int an = 0, bn = 0;
        for (var x = 0; x < a.GetLength(0); x++)
            for (var y = 0; y < a.GetLength(1); y++)
            {
                if (a[x, y] && b[x, y]) inter++;
                if (a[x, y] || b[x, y]) union++;
                if (a[x, y]) { ax += x; ay += y; an++; }
                if (b[x, y]) { bx += x; by += y; bn++; }
            }
        return ((double)inter / Math.Max(union, 1), ax / Math.Max(an, 1) - bx / Math.Max(bn, 1), ay / Math.Max(an, 1) - by / Math.Max(bn, 1));
    }

    [Theory]
    [InlineData(true, "checked")]
    [InlineData(null, "mixed")]
    public async Task флажок_рисуется_как_в_Electron(bool? state, string name)
    {
        bool[,]? wpf = null, wpfBox = null;
        await WpfHost.Run(() =>
        {
            var box = new CheckBox { Style = (Style)Application.Current.FindResource("GlassCheck"), IsThreeState = true, IsChecked = state };
            var host = new Grid { Background = new SolidColorBrush(Color.FromRgb(0x1C, 0x21, 0x28)), Width = 16, Height = 16, LayoutTransform = new ScaleTransform(4, 4) };
            host.Children.Add(box);
            host.Measure(new Size(64, 64));
            host.Arrange(new Rect(0, 0, 64, 64));
            host.UpdateLayout();
            var bmp = new RenderTargetBitmap(64, 64, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(host);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(bmp));
            using (var f = File.Create(Path.Combine(AppContext.BaseDirectory, $"checkbox-{name}-wpf-4x.png"))) enc.Save(f);
            wpf = WhiteMask(bmp);
            wpfBox = AccentMask(bmp);
            return Task.CompletedTask;
        });
        var reference = new PngBitmapDecoder(new Uri(Path.Combine(AppContext.BaseDirectory, "look", $"checkbox-{name}-electron-4x.png")),
            BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
        var (boxIou, _, _) = Compare(wpfBox!, AccentMask(reference));
        var (iou, dx, dy) = Compare(wpf!, WhiteMask(reference));
        Assert.True(boxIou > 0.97, $"квадрат флажка совпадает на {boxIou:P0}: у WPF без рамки он меньше");
        Assert.True(iou > 0.85 && Math.Abs(dx) < 1 && Math.Abs(dy) < 1,
            $"совпадение {iou:P0}, сдвиг центра ({dx:F1}; {dy:F1}) px при увеличении 4x");
    }
}

[CollectionDefinition("Окно", DisableParallelization = true)]
public class WindowCollection;
