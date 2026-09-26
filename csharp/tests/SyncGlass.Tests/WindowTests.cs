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
            App.StylesOnly = true; // без замка «одна копия» и настоящего окна - см. App.StylesOnly
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

    internal static FakeApi DemoApi() => new()
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
        Assert.True(мс < 1500, $"раскрытие с раскладкой: {мс:F0} мс"); // запас на раннер CI, старое - 8000 мс
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
        Assert.True(мс < 600, $"открытие истории: {мс:F0} мс"); // время - с запасом на медленный раннер CI (там 230 мс), старое - 1236 мс
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

    private static bool[,] Or(bool[,] a, bool[,] b)
    {
        var r = new bool[a.GetLength(0), a.GetLength(1)];
        for (var x = 0; x < a.GetLength(0); x++)
            for (var y = 0; y < a.GetLength(1); y++) r[x, y] = a[x, y] || b[x, y];
        return r;
    }

    private static bool[,] Shift(bool[,] a, int dx, int dy)
    {
        var r = new bool[a.GetLength(0), a.GetLength(1)];
        for (var x = 0; x < a.GetLength(0); x++)
            for (var y = 0; y < a.GetLength(1); y++)
            {
                int sx = x - dx, sy = y - dy;
                if (sx >= 0 && sy >= 0 && sx < a.GetLength(0) && sy < a.GetLength(1)) r[x, y] = a[sx, sy];
            }
        return r;
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

    // Кадр флажка WPF в натуральную величину (без увеличения) - для сравнения с Electron 1x.
    private static Task<BitmapSource> RenderCheck(bool? state, int scale)
    {
        BitmapSource? result = null;
        return WpfHost.Run(() =>
        {
            var box = new CheckBox { Style = (Style)Application.Current.FindResource("GlassCheck"), IsThreeState = true, IsChecked = state };
            var host = new Grid { Background = new SolidColorBrush(Color.FromRgb(0x1C, 0x21, 0x28)), Width = 16, Height = 16, LayoutTransform = new ScaleTransform(scale, scale), UseLayoutRounding = true };
            host.Children.Add(box);
            host.Measure(new Size(16 * scale, 16 * scale));
            host.Arrange(new Rect(0, 0, 16 * scale, 16 * scale));
            host.UpdateLayout();
            var bmp = new RenderTargetBitmap(16 * scale, 16 * scale, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(host);
            bmp.Freeze();
            result = bmp;
            return Task.CompletedTask;
        }).ContinueWith(_ => result!);
    }

    // Черта «частично» здесь не сравнивается: Chromium в натуральную величину ставит её на
    // целый пиксель (7 вместо 7.5), и WPF повторяет именно это - её закон в 1x ниже.
    [Theory]
    [InlineData(true, "checked")]
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
        // Квадрат - синее вместе с белым: галочка лежит на нём и в маску синего не входит.
        var (boxIou, _, _) = Compare(Or(wpfBox!, wpf!), Or(AccentMask(reference), WhiteMask(reference)));
        // Галочка: форма - после совмещения центров, сдвиг - отдельно и не больше 0.6 px в
        // натуральную величину (2.4 при 4x). В 4x Chromium ставит её ровно на left 5.5, а в
        // 1x - на целый пиксель, как черту; окно округляет так же, поэтому в разметке 5, и
        // главный закон - сравнение в 1x выше.
        var (_, dx, dy) = Compare(wpf!, WhiteMask(reference));
        var (iou, _, _) = Compare(Shift(wpf!, -(int)Math.Round(dx), -(int)Math.Round(dy)), WhiteMask(reference));
        Assert.True(boxIou > 0.97, $"квадрат флажка совпадает на {boxIou:P0}: у WPF без рамки он меньше");
        Assert.True(iou > 0.85 && Math.Abs(dx) <= 2.4 && Math.Abs(dy) <= 2.4,
            $"форма совпадает на {iou:P0}, сдвиг центра ({dx:F1}; {dy:F1}) px при увеличении 4x");
    }
    // Закон: флажки в настоящем окне, в натуральную величину, - как у Electron 1x. Второй
    // раз «галочки кривые» (26.09.2026): сравнение в 4x проходило, а в окне галочка сидела
    // на пиксель правее и ниже - окно округляет разметку (UseLayoutRounding), рамка 1.5
    // становилась 2, а галочка считалась от её внутреннего края. Сравнение - по яркости
    // (min каналов) внутри квадрата, без скруглённых углов; эталоны в look/*-1x.png.
    private static double[,] Lum(BitmapSource src)
    {
        var conv = new FormatConvertedBitmap(src, PixelFormats.Bgra32, null, 0);
        var px = new byte[16 * 16 * 4];
        conv.CopyPixels(new Int32Rect(0, 0, 16, 16), px, 16 * 4, 0);
        var l = new double[16, 16];
        for (var y = 0; y < 16; y++)
            for (var x = 0; x < 16; x++)
            {
                var i = (y * 16 + x) * 4;
                l[x, y] = Math.Min(px[i], Math.Min(px[i + 1], px[i + 2]));
            }
        return l;
    }

    private static double Diff(double[,] a, double[,] b)
    {
        double sum = 0; var n = 0;
        for (var x = 0; x < 16; x++)
            for (var y = 0; y < 16; y++)
            {
                if ((x < 3 || x > 12) && (y < 3 || y > 12)) continue; // скруглённые углы
                sum += Math.Abs(a[x, y] - b[x, y]);
                n++;
            }
        return sum / n;
    }

    private static BitmapSource Look(string name) => new PngBitmapDecoder(new Uri(Path.Combine(AppContext.BaseDirectory, "look", name)),
        BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];

    [Fact]
    public async Task флажки_в_окне_в_натуральную_величину_как_в_Electron()
    {
        var расхождения = new List<double>();
        await WpfHost.Run(async () =>
        {
            var vm = new MainViewModel(DemoApi());
            var win = new MainWindow { PlacementFile = null, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -3000, Top = 0 };
            win.Attach(vm, null);
            win.Show();
            try
            {
                for (var i = 0; i < 100 && vm.Rows.Count < 3; i++) await Task.Delay(20);
                vm.OnSelectAll(true);
                win.UpdateLayout();
                await Task.Delay(50);
                var эталон = Lum(Look("checkbox-checked-electron-1x.png"));
                foreach (var cb in Tree(win).OfType<CheckBox>().Where(c => c.IsVisible && c.IsChecked == true))
                {
                    DependencyObject? up = cb;
                    while (up is not null and not ListBoxItem) up = VisualTreeHelper.GetParent(up);
                    var host = (FrameworkElement)(up ?? cb);
                    var bmp = new RenderTargetBitmap((int)Math.Ceiling(host.ActualWidth), (int)Math.Ceiling(host.ActualHeight), 96, 96, PixelFormats.Pbgra32);
                    bmp.Render(host);
                    var p = cb.TranslatePoint(new Point(0, 0), host);
                    var crop = new CroppedBitmap(bmp, new Int32Rect((int)Math.Round(p.X), (int)Math.Round(p.Y), 16, 16));
                    var alpha = new byte[16 * 16 * 4];
                    new FormatConvertedBitmap(crop, PixelFormats.Bgra32, null, 0).CopyPixels(alpha, 16 * 4, 0);
                    if (alpha.Where((_, i) => i % 4 == 3).All(a => a == 0)) continue; // строка вне видимой части списка не рисуется
                    расхождения.Add(Diff(Lum(crop), эталон));
                }
            }
            finally
            {
                win.Close();
            }
        });
        Assert.True(расхождения.Count >= 2, $"флажков найдено {расхождения.Count}");
        Assert.All(расхождения, d => Assert.True(d < 6, $"флажок отличается от Electron в среднем на {d:F1} из 255 (кривая галочка - 15+)"));
    }

    [Fact]
    public async Task черта_флажка_в_натуральную_величину_как_в_Electron()
    {
        var bmp = await RenderCheck(null, 1);
        var d = Diff(Lum(bmp), Lum(Look("checkbox-mixed-electron-1x.png")));
        Assert.True(d < 6, $"черта отличается от Electron в среднем на {d:F1} из 255");
    }

    // Закон: тестовое окно не запускает программу - ни замка «одна копия», ни окна на
    // настоящих данных; тесты окна проходят и при запущенном SyncGlass.
    [Fact]
    public async Task тесты_окна_не_запускают_программу()
    {
        var (окон, закрывается, режим) = (-1, true, ShutdownMode.OnMainWindowClose);
        await WpfHost.Run(async () =>
        {
            await Task.Delay(100); // запуск Application идёт из очереди диспетчера
            окон = Application.Current.Windows.OfType<MainWindow>().Count();
            закрывается = Application.Current.Dispatcher.HasShutdownStarted;
            режим = Application.Current.ShutdownMode;
        });
        Assert.Equal(0, окон);
        Assert.False(закрывается);
        Assert.Equal(ShutdownMode.OnExplicitShutdown, режим); // закрытое тестовое окно не гасит остальные тесты
    }

    // Закон: галочка - посередине квадрата. Третий раз «галочки кривые» (26.09.2026, «подними
    // чуть повыше и чуть левее»): C# уже совпадал с Electron, но у самого Electron галочка
    // сидела на 0.9 px правее и на 1.7 px ниже середины. Середина - центр тяжести белого
    // сверх цвета квадрата; проверяются и эталон Electron, и кадр WPF.
    private static (double x, double y) Ink(double[,] l)
    {
        double sx = 0, sy = 0, sw = 0, фон = l[7, 1];
        for (var x = 0; x < 16; x++)
            for (var y = 0; y < 16; y++)
            {
                var w = Math.Max(0, l[x, y] - фон - 8);
                sx += w * x; sy += w * y; sw += w;
            }
        return (sx / sw, sy / sw);
    }

    [Theory]
    [InlineData("electron")]
    [InlineData("wpf")]
    public async Task галочка_посередине_квадрата(string source)
    {
        // Эталон читается тоже в потоке окна: картинка, открытая в потоке теста раньше окна,
        // заводила там свой Dispatcher, и остальные тесты окна падали с «идёт завершение работы».
        double[,]? l = null;
        var wpf = source == "wpf" ? await RenderCheck(true, 1) : null;
        await WpfHost.Run(() => { l = Lum(wpf ?? Look("checkbox-checked-electron-1x.png")); return Task.CompletedTask; });
        var (x, y) = Ink(l!);
        Assert.True(Math.Abs(x - 7.5) < 0.5 && Math.Abs(y - 7.5) < 0.5,
            $"галочка {source}: центр ({x:F2}; {y:F2}), середина квадрата (7.5; 7.5)");
    }
}

[CollectionDefinition("Окно", DisableParallelization = true)]
public class WindowCollection;
