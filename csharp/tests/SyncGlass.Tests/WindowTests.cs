using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
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
}

[CollectionDefinition("Окно", DisableParallelization = true)]
public class WindowCollection;
