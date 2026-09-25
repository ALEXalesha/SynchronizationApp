using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using SyncGlass.Core.Main;
using SyncGlass.Ui;
using SyncGlass.Wpf;

// Кадры C#-окна для README - программой, а не снимком экрана (как make-screenshots.js).
// Своя временная папка данных: настройки, кеши и история человека не трогаются.
// Две выдуманные папки «Ноутбук» и «Сетевой ПК»; честно: «сетевая» - вторая локальная
// папка, настоящей шары тут нет. Кадр берётся с самого окна (RenderTargetBitmap),
// поэтому чужое окно в него не попадёт.

var root = FindRepo();
var outDir = Path.Combine(root, "docs", "screenshots");
var tmp = Directory.CreateTempSubdirectory("syncglass-shots-").FullName;
var local = Path.Combine(tmp, "Ноутбук", "Проекты");
var network = Path.Combine(tmp, "Сетевой ПК", "Проекты");
var userData = Path.Combine(tmp, "userData");
var code = 0;

var thread = new Thread(() =>
{
    var app = new App();
    app.InitializeComponent();
    app.Dispatcher.InvokeAsync(async () =>
    {
        try
        {
            MakeDemo(local, network);
            Directory.CreateDirectory(userData);
            File.WriteAllText(Path.Combine(userData, "settings.json"),
                $"{{\"localPath\":{System.Text.Json.JsonSerializer.Serialize(local)},\"networkPath\":{System.Text.Json.JsonSerializer.Serialize(network)},\"direction\":\"toNetwork\",\"sort\":\"name\",\"sizeMode\":\"capped\"}}");

            var backend = new Backend(userData);
            var win = new MainWindow { PlacementFile = null, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -3000, Top = 0 };
            var vm = new MainViewModel(new BackendApi(backend, () => Task.FromResult<string?>(null)));
            win.Attach(vm, backend);
            win.Show();

            await Until(() => vm.Rows.Count >= 4, "дерево");
            await Until(() => vm.StatusKind == "done", "размеры", 20000);
            foreach (var name in new[] { "Курсовая", "Сайт" })
                await vm.ToggleExpand(vm.Roots.Single(n => n.Name == name));
            vm.OnSelectAll(true);
            await Until(() => vm.CanSync, "кнопка синхронизации");
            Shoot(win, Path.Combine(outDir, "window-csharp.png"));

            _ = vm.Preview.Open();
            await Until(() => vm.Preview.StatsVisible, "предпросмотр");
            Shoot(win, Path.Combine(outDir, "preview-csharp.png"));
            Console.WriteLine($"сводка в кадре: +{vm.Preview.Copy.Value} ~{vm.Preview.Overwrite.Value} −{vm.Preview.Trash.Value} →{vm.Preview.Move.Value}");
            win.Close();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            code = 1;
        }
        finally
        {
            app.Shutdown();
        }
    });
    app.Run();
});
thread.SetApartmentState(ApartmentState.STA);
thread.Start();
thread.Join();
try { Directory.Delete(tmp, true); } catch { /* занято - Windows подчистит временную папку сама */ }
return code;

static async Task Until(Func<bool> cond, string what, int timeout = 15000)
{
    var end = DateTime.UtcNow.AddMilliseconds(timeout);
    while (DateTime.UtcNow < end)
    {
        if (cond()) return;
        await Task.Delay(150);
    }
    throw new TimeoutException("не дождались: " + what);
}

static void Shoot(Window win, string file)
{
    // Дать окну дорисоваться (привязки, раскладка), затем снять его содержимое.
    win.Dispatcher.Invoke(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
    var content = (FrameworkElement)win.Content;
    var dpi = VisualTreeHelper.GetDpi(win);
    var bmp = new RenderTargetBitmap((int)Math.Round(content.ActualWidth * dpi.DpiScaleX), (int)Math.Round(content.ActualHeight * dpi.DpiScaleY),
                                     dpi.PixelsPerInchX, dpi.PixelsPerInchY, PixelFormats.Pbgra32);
    bmp.Render(content);
    var enc = new PngBitmapEncoder();
    enc.Frames.Add(BitmapFrame.Create(bmp));
    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
    using var fs = File.Create(file);
    enc.Save(fs);
    Console.WriteLine("  " + Path.GetFileName(file));
}

static void MakeDemo(string local, string network)
{
    var now = DateTime.Now;
    void Put(string rootDir, string rel, string text, int daysAgo)
    {
        var file = Path.Combine(rootDir, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
        File.SetLastWriteTime(file, now.AddDays(-daysAgo));
    }
    // Выдуманные проекты - те же, что у Electron: новое, изменённое, переложенное, лишнее.
    var photo = new string('x', 40000);
    Put(local, "Курсовая/глава 1.docx", "глава 1, правки научного", 1);
    Put(local, "Курсовая/глава 2.docx", "глава 2", 0);
    Put(local, "Курсовая/литература.txt", "список", 12);
    Put(local, "Фото/2026-08 поход/IMG_0412.jpg", photo, 30);
    Put(local, "Фото/2026-08 поход/IMG_0413.jpg", photo, 30);
    Put(local, "Фото/2026-09 дача/IMG_0501.jpg", photo, 5);
    Put(local, "Сайт/index.html", "<h1>привет</h1>", 3);
    Put(local, "Сайт/архив/старый-макет.fig", "макет", 40);
    Put(local, "заметки.md", "новые заметки", 0);

    Put(network, "Курсовая/глава 1.docx", "глава 1", 8);
    Put(network, "Курсовая/литература.txt", "список", 12);
    Put(network, "Фото/2026-08 поход/IMG_0412.jpg", photo, 30);
    Put(network, "Фото/2026-08 поход/IMG_0413.jpg", photo, 30);
    Put(network, "Сайт/index.html", "<h1>привет</h1>", 3);
    Put(network, "Сайт/старый-макет.fig", "макет", 40);
    Put(network, "заметки.md", "заметки", 9);
    Put(network, "черновик-удалённый.txt", "устарело", 60);
}

static string FindRepo()
{
    for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        if (Directory.Exists(Path.Combine(d.FullName, "csharp")) && File.Exists(Path.Combine(d.FullName, "main.js"))) return d.FullName;
    throw new DirectoryNotFoundException("корень репозитория не найден");
}
