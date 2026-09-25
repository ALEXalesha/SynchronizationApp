using SyncGlass.Core;
using SyncGlass.Core.Main;
using SyncGlass.Ui;

namespace SyncGlass.Tests;

// Поддельный мост - как заглушка window.api в test/helpers/renderer-harness.js.
internal sealed class FakeApi : IApi
{
    public Func<string, ListResult> List { get; set; } = _ => new ListResult(new(), true, true);
    public ProbeResult ProbeAnswer { get; set; } = new(true, true);
    public PreviewResult? PreviewAnswer { get; set; }
    public SyncResult? SyncAnswer { get; set; }
    public List<HistoryRun> HistoryAnswer { get; set; } = new();
    public AppSettings SettingsAnswer { get; set; } = new();
    public int Crawls, Stops, ListCalls;

    public Task<AppSettings> GetSettings() => Task.FromResult(SettingsAnswer);
    public Task SaveSettings(AppSettings settings) => Task.CompletedTask;
    public Task<List<HistoryRun>> GetHistory() => Task.FromResult(HistoryAnswer);
    public Task ClearHistory() => Task.CompletedTask;
    public Task<string?> PickFolder() => Task.FromResult<string?>(null);
    public Task<ProbeResult> Probe(string? l, string? n) => Task.FromResult(ProbeAnswer);
    public Task<ListResult> ListFolders(string? l, string? n, string relPath, bool force, bool needMtime)
    {
        ListCalls++;
        return Task.FromResult(List(relPath));
    }
    public Task<PreviewResult> Preview(SyncArgs args, IProgress<int>? progress) => Task.FromResult(PreviewAnswer ?? new PreviewResult(Error: "нет"));
    public void CancelPreview() { }
    public Task<SyncResult> Sync(SyncArgs args, IProgress<SyncProgress>? progress) => Task.FromResult(SyncAnswer ?? new SyncResult());
    public void CancelSync() { }
    public Task<CrawlResult> StartCrawl(string? l, string? n, bool noLimit, ICrawlSink sink)
    {
        Crawls++;
        return Task.FromResult(new CrawlResult(true));
    }
    public void StopCrawl() => Stops++;
}

// Перенос test/renderer.test.js и окна истории из history.test.js: модель выбора в дереве
// (трёхпозиционные отметки, наследование, регистр), дерево, предпросмотр. Отсюда уходят
// folders и excludes в ядро: ошибка здесь - синхронизация не того, что отметил человек.
public class ViewModelTests
{
    private static MainViewModel Fresh(FakeApi? api = null) => new(api ?? new FakeApi());

    private static ListItem Dto(string relPath, bool isDir = true, bool hasLocal = true, bool hasNetwork = true, double mtime = 0)
        => new(relPath.Split('/')[^1], relPath, isDir, hasLocal, hasNetwork, mtime);

    private static TreeNode Node(string relPath, bool isDir = true) => new(Dto(relPath, isDir));

    private static (List<string> Folders, List<string> Excludes) Selection(MainViewModel vm)
    {
        var (f, e) = vm.CollectSelection();
        return (f.OrderBy(x => x, StringComparer.Ordinal).ToList(), e.OrderBy(x => x, StringComparer.Ordinal).ToList());
    }

    private static void Sel(MainViewModel vm, string[] folders, string[] excludes)
    {
        var (f, e) = Selection(vm);
        Assert.Equal(folders, f);
        Assert.Equal(excludes, e);
    }

    [Fact]
    public void отмеченная_папка_попадает_в_выбор()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("док"));
        Sel(vm, ["док"], []);
    }

    [Fact]
    public void снятая_внутри_ветки_подпапка_становится_исключением()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("док"));
        vm.ToggleCheck(Node("док/архив"));
        var (f, e) = Selection(vm);
        Assert.Equal(["док"], f);
        Assert.Equal(["док/архив"], e);
        Assert.False(vm.IsIncluded("док/архив/файл.txt"));
    }

    [Fact]
    public void самая_точная_отметка_главнее_вложенная_часть_внутри_исключённой()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("док"));
        vm.ToggleCheck(Node("док/архив"));
        vm.ToggleCheck(Node("док/архив/2024"));
        var (f, e) = Selection(vm);
        Assert.Equal(["док", "док/архив/2024"], f);
        Assert.Equal(["док/архив"], e);
        Assert.True(vm.IsIncluded("док/архив/2024/отчёт.txt"));
        Assert.False(vm.IsIncluded("док/архив/прочее.txt"));
    }

    // Чёрточка одинакова и у отмеченной ветки со снятой подпапкой, и у неотмеченной
    // с отмеченной подпапкой - клик обязан вести себя одинаково: включать ветку целиком.
    [Fact]
    public void клик_по_частичному_узлу_включает_ветку_целиком_в_обоих_случаях()
    {
        var a = Fresh();
        a.ToggleCheck(Node("док"));
        a.ToggleCheck(Node("док/архив"));
        Assert.Equal(Check.Partial, a.NodeCheckState("док"));
        a.ToggleCheck(Node("док"));
        Sel(a, ["док"], []);

        var b = Fresh();
        b.ToggleCheck(Node("док/архив"));
        Assert.Equal(Check.Partial, b.NodeCheckState("док"));
        b.ToggleCheck(Node("док"));
        Sel(b, ["док"], []);
    }

    [Fact]
    public void повторный_клик_по_отмеченной_ветке_снимает_выбор()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("док"));
        vm.ToggleCheck(Node("док"));
        Sel(vm, [], []);
    }

    [Fact]
    public void отметка_находится_независимо_от_написания_пути()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("Док"));
        Assert.True(vm.IsIncluded("док"));
        Assert.True(vm.IsIncluded("ДОК/внутри/ф.txt"));
    }

    [Fact]
    public void исключение_в_другом_написании_ложится_на_ту_же_ветку()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("Док"));
        vm.ToggleCheck(Node("док/Архив"));
        Sel(vm, ["Док"], ["док/Архив"]);
        Assert.False(vm.IsIncluded("ДОК/архив/ф.txt"));
    }

    [Fact]
    public void клик_по_тому_же_узлу_в_другом_регистре_снимает_отметку_а_не_заводит_вторую()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("Отчёт"));
        vm.ToggleCheck(Node("отчёт"));
        Assert.Empty(vm.Marks);
    }

    [Fact]
    public void отметка_исчезнувшей_папки_убирается_написание_корня_подгоняется()
    {
        var vm = Fresh();
        vm.Roots = [Node("Док")];
        vm.ToggleCheck(Node("док"));
        vm.ToggleCheck(Node("док/внутри"));
        vm.ToggleCheck(Node("пропала"));
        vm.PruneMarks(true, true);
        var (f, e) = Selection(vm);
        Assert.Equal(["Док"], f);
        Assert.Equal(["Док/внутри"], e);
    }

    // Недоступная сторона отдаёт пустой список - чистить по нему нельзя.
    [Fact]
    public void моргнувшая_связь_не_стирает_отметки()
    {
        var vm = Fresh();
        vm.LocalPath = "C:/local";
        vm.NetworkPath = @"\\srv\share";
        vm.Roots = [];
        vm.ToggleCheck(Node("док"));
        vm.PruneMarks(false, true);
        Sel(vm, ["док"], []);
    }

    [Fact]
    public void выбрать_все_и_снять_все()
    {
        var vm = Fresh();
        vm.Roots = [Node("a"), Node("b"), Node("c")];
        vm.OnSelectAll(true);
        Assert.Equal(["a", "b", "c"], Selection(vm).Folders);
        Assert.True(vm.AllChecked);
        vm.ToggleCheck(Node("b"));
        Assert.Equal(["a", "c"], Selection(vm).Folders);
        Assert.False(vm.AllChecked);
        vm.OnSelectAll(false);
        Sel(vm, [], []);
    }

    [Fact]
    public void состояние_узлов_вокруг_глубокого_исключения()
    {
        var vm = Fresh();
        vm.ToggleCheck(Node("п"));
        vm.ToggleCheck(Node("п/q/r/s"));
        Assert.Equal(Check.Partial, vm.NodeCheckState("п"));
        Assert.Equal(Check.Partial, vm.NodeCheckState("п/q/r"));
        Assert.Equal(Check.Checked, vm.NodeCheckState("п/q/сосед"));
        Assert.True(vm.IsIncluded("п/q/r"));
        Assert.False(vm.IsIncluded("п/q/r/s/глубже.txt"));
    }

    // «Внутри есть отметки» спрашивается на каждую строку; перебор всех отметок на строку
    // давал треть секунды на перерисовку при «Выбрать все» на 30 тысячах узлов.
    [Fact]
    public void чёрточки_не_платят_произведением_строк_на_отметки()
    {
        var vm = Fresh();
        vm.Roots = Enumerable.Range(0, 30000).Select(i => Node($"снимок{i}.jpg", false)).ToList();
        vm.OnSelectAll(true);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 500; i++) vm.NodeCheckState($"снимок{i}.jpg");
        sw.Stop();
        Assert.Equal(Check.Checked, vm.NodeCheckState("снимок0.jpg"));
        Assert.True(sw.ElapsedMilliseconds < 100, $"500 строк заняли {sw.ElapsedMilliseconds} мс - похоже на перебор всех отметок");
    }

    // Запомненный ответ «есть ли отметки внутри» обязан сбрасываться на каждой правке.
    [Fact]
    public void запомненный_ответ_про_отметки_внутри_сбрасывается_на_каждой_правке()
    {
        var vm = Fresh();
        vm.Roots = [Node("док"), Node("фото")];
        Assert.False(vm.HasDescendantMark("док"));
        vm.ToggleCheck(Node("док"));
        vm.ToggleCheck(Node("док/архив"));
        Assert.True(vm.HasDescendantMark("док"));
        Assert.Equal(Check.Partial, vm.NodeCheckState("док"));

        vm.ToggleCheck(Node("док"));
        Assert.False(vm.HasDescendantMark("док"));
        Assert.Equal(Check.Checked, vm.NodeCheckState("док"));

        vm.OnSelectAll(true);
        Assert.False(vm.HasDescendantMark("док"));
        vm.ToggleCheck(Node("док/архив"));
        Assert.True(vm.HasDescendantMark("док"));

        vm.Roots = [Node("фото")];
        vm.PruneMarks(true, true);
        Assert.False(vm.HasDescendantMark("док"));
    }

    // ---- Предпросмотр ----

    private static PreviewResult Result(List<FolderCount> perFolder, Summary totals, List<string>? skipped = null, int skippedTotal = 0)
        => new(perFolder, totals, skipped ?? [], skippedTotal);

    private static Summary S(int copy = 0, int trash = 0, int move = 0, int overwrite = 0, int unchanged = 0, int dirs = 0)
        => new(move, copy, overwrite, trash, unchanged, dirs, move + copy + overwrite + trash + dirs);

    private static FolderCount Idle(string name) => new(name, S(unchanged: 3));
    private static FolderCount Busy(string name) => new(name, S(copy: 2));

    private static List<PreviewRow> PreviewOf(List<FolderCount> perFolder)
    {
        var vm = Fresh();
        vm.Preview.Render(Result(perFolder, S(copy: 1)));
        return vm.Preview.Rows.ToList();
    }

    [Fact]
    public void короткий_список_веток_показывается_целиком_как_и_раньше()
    {
        var rows = PreviewOf([Busy("док"), Idle("фото"), Idle("музыка")]);
        Assert.Contains(rows, r => r.Folder == "док" && r.Counts == "+2");
        Assert.Contains(rows, r => r.Folder == "фото" && r.Counts == "без изменений");
        Assert.Contains(rows, r => r.Folder == "музыка");
        Assert.True(rows[0].IsHead);
    }

    [Fact]
    public void на_тысячах_веток_список_сворачивается_а_не_строит_строку_на_каждую()
    {
        var perFolder = new List<FolderCount> { Busy("нужная"), Busy("тоже-нужная") };
        perFolder.AddRange(Enumerable.Range(0, 5000).Select(i => Idle($"пустая{i}")));
        var rows = PreviewOf(perFolder);
        Assert.True(rows.Count < 600, $"строк {rows.Count} - список не свернулся");
        Assert.Contains(rows, r => r.Folder == "нужная");
        Assert.Contains(rows, r => r.Folder == "тоже-нужная");
        Assert.Contains(rows, r => r.IsMore && r.Folder.Replace('\u00A0', ' ') == "5 000 без изменений");
        Assert.DoesNotContain(rows, r => r.Folder == "пустая4999");
    }

    [Fact]
    public void размер_строки_находится_при_другом_написании_пути()
    {
        var vm = Fresh();
        var n = new TreeNode(new ListItem("Док", "Док", true, true, false, 0));
        Assert.Equal("нет в сети", vm.MetaFor(n, "network").Text);
        Assert.Equal("", vm.MetaFor(n, "local").Text);
        vm.MergeSizes([new SizeEntry("док", 2048, 3, null, null)]);
        Assert.Contains("3 файлов", vm.MetaFor(n, "local").Text);
    }

    [Fact]
    public void шкала_размеров_не_кончается_раньше_числа()
    {
        Assert.Equal("0 Б", Format.FormatSize(0));
        Assert.Equal("", Format.FormatSize(null));
        Assert.Equal("1.5 КБ", Format.FormatSize(1536));
        Assert.EndsWith("ПБ", Format.FormatSize(long.MaxValue));
    }

    // В WPF разметки нет: имя с диска выводится текстом, как есть (в JS его экранировали
    // перед innerHTML). Закон «имя не становится разметкой» тут держит сам TextBlock;
    // проверяем, что имя доходит до строк без искажений.
    [Fact]
    public void имя_с_диска_доходит_до_строк_дерева_предпросмотра_и_истории_как_есть()
    {
        const string злое = "<i&\"'>злое";
        var vm = Fresh();
        vm.Roots = [Node(злое)];
        vm.RenderTree();
        Assert.Equal(злое, vm.Rows.Single().Name);
        vm.Preview.Render(Result([Busy(злое)], S(copy: 2), [злое], 1));
        Assert.Contains(vm.Preview.Rows, r => r.Folder == злое);
        Assert.Contains(vm.Preview.Notices, n => n.Text.Contains(злое));
        var files = HistoryModel.FilesOf(new HistoryRun { Files = [new HistoryFile("copy", злое)] });
        Assert.Equal("+ " + злое, files.Single().Text);
    }

    [Fact]
    public void папки_всегда_выше_файлов_по_дате_новые_сверху()
    {
        var vm = Fresh();
        vm.Sort = "name";
        var byName = vm.SortNodes([new(Dto("я", false, mtime: 9)), new(Dto("б", true, mtime: 1)), new(Dto("а", false, mtime: 5))]);
        Assert.Equal(["б", "а", "я"], byName.Select(n => n.Name));
        vm.Sort = "date";
        var byDate = vm.SortNodes([new(Dto("старый", false, mtime: 1)), new(Dto("новый", false, mtime: 99))]);
        Assert.Equal(["новый", "старый"], byDate.Select(n => n.Name));
    }

    // ---- Написание имени и опознание узла ----

    private static async Task<MainViewModel> WithListing(params string[] names)
    {
        var api = new FakeApi { List = _ => new ListResult(names.Select(n => Dto(n)).ToList(), true, true) };
        var vm = Fresh(api);
        vm.LocalPath = @"C:\local";
        vm.NetworkPath = @"\\server\share";
        await Task.CompletedTask;
        return vm;
    }

    [Fact]
    public async Task смена_написания_не_схлопывает_раскрытую_ветку_и_не_теряет_её_детей()
    {
        var vm = await WithListing("Док");
        var корень = new TreeNode(Dto("док")) { Loaded = true };
        корень.Children = [new TreeNode(Dto("док/внутри"))];
        vm.Roots = [корень];
        vm.Expanded.Add(MainViewModel.ExpandKey("док"));

        await vm.LightRelistTop();

        Assert.Single(vm.Roots);
        Assert.Same(корень, vm.Roots[0]);
        Assert.Equal("Док", vm.Roots[0].Name);
        Assert.True(vm.Roots[0].Loaded);
        Assert.Single(vm.Roots[0].Children);
        Assert.True(vm.IsExpanded("Док"));
    }

    [Fact]
    public async Task смена_написания_перерисовывает_строку_а_не_только_модель()
    {
        var vm = await WithListing("Док");
        vm.Roots = [new TreeNode(Dto("док"))];
        var before = vm.RenderCount;

        await vm.LightRelistTop();
        Assert.Equal("Док", vm.Roots[0].Name);
        Assert.Equal(before + 1, vm.RenderCount);

        // Второй тик ничего не меняет: лишних перерисовок каждые 6 секунд быть не должно.
        await vm.LightRelistTop();
        Assert.Equal(before + 1, vm.RenderCount);
    }

    [Fact]
    public async Task отметка_переживает_смену_написания_вместе_с_узлом()
    {
        var vm = await WithListing("Док");
        vm.Roots = [new TreeNode(Dto("док"))];
        vm.ToggleCheck(Node("док"));
        await vm.LightRelistTop();
        Assert.Equal(["Док"], vm.CollectSelection().Folders);
    }

    // Предпросмотр - место, где человек решает судьбу файлов: подпись и предупреждение
    // проверяются на смысл.
    private static PreviewModel SummaryOf(int trash)
    {
        var vm = Fresh();
        vm.Preview.Render(Result([new FolderCount("док", S(copy: 1, trash: trash))], S(copy: 1, trash: trash)));
        return vm.Preview;
    }

    [Fact]
    public void предпросмотр_обещает_удаление_а_не_Корзину()
    {
        var p = SummaryOf(3);
        Assert.Equal("удалить", p.Trash.Label);
        Assert.DoesNotContain(p.Notices, n => n.Text.Contains("в Корзину"));
        Assert.Contains(p.Notices, n => n.Kind == "warn" && n.Text.Contains("безвозвратно"));
    }

    [Fact]
    public void без_удалений_предупреждение_не_показывается()
        => Assert.DoesNotContain(SummaryOf(0).Notices, n => n.Text.Contains("безвозвратно"));

    [Fact]
    public void большие_счётчики_печатаются_с_разрядами_и_мельче()
    {
        var vm = Fresh();
        vm.Preview.Render(Result([new FolderCount("док", S(copy: 1234567, overwrite: 98765, trash: 3))], S(copy: 1234567, overwrite: 98765, trash: 3)));
        Assert.Equal("1 234 567", vm.Preview.Copy.Value.Replace('\u00A0', ' '));
        Assert.Equal("num-s", vm.Preview.Copy.SizeClass);
        Assert.Equal("3", vm.Preview.Trash.Value);
        Assert.Equal("", vm.Preview.Trash.SizeClass);
    }

    [Fact]
    public void во_время_работы_из_N_отдельной_строкой_а_не_через_косую()
    {
        var s = new StatItem("copy", "скопировать");
        s.Set(12345, 67890);
        Assert.Equal("12 345", s.Value.Replace('\u00A0', ' '));
        Assert.Equal("из 67 890", s.Of!.Replace('\u00A0', ' '));
        Assert.DoesNotContain("/", s.Value + s.Of);
    }

    [Fact]
    public void размер_шрифта_плашки_растёт_вниз_вместе_с_длиной_числа()
    {
        string[] order = ["", "num-m", "num-s", "num-xs"];
        var prev = 0;
        foreach (var n in new long[] { 0, 7, 42, 999, 1000, 99999, 100000, 9999999, 10000000, 1_000_000_000, 1_000_000_000_000 })
        {
            var rank = Array.IndexOf(order, Format.NumSize(Format.FmtNum(n)));
            Assert.True(rank >= prev, $"{n}: мельче, чем у числа поменьше");
            prev = rank;
        }
        Assert.Equal(3, prev);
    }

    // ---- История: окно (history.test.js) ----

    [Fact]
    public void окно_истории_не_строит_строки_файлов_пока_запуск_не_раскрыли()
    {
        var vm = Fresh();
        vm.History.Render([new HistoryRun { Time = "2026-01-01T00:00:00.000Z", Direction = "toNetwork", Files = [new("copy", "а/б.txt"), new("trash", "в/г.txt")] }]);
        var row = vm.History.Runs.Single();
        Assert.Null(row.Files);
        vm.History.Toggle(row);
        Assert.Equal(["+ а/б.txt", "− в/г.txt"], row.Files!.Select(f => f.Text));

        var dropped = HistoryModel.FilesOf(new HistoryRun { DetailsDropped = true, FileCount = 4321 });
        Assert.Contains("не сохранён", dropped.Single().Text);
        Assert.Contains("4 321", dropped.Single().Text.Replace('\u00A0', ' '));
    }

    // ---- Нового в C#: дерево на экране ----

    // Строки правятся на месте: перерисовка во время обхода не пересоздаёт строки, иначе
    // список прыгал бы к началу раз в 400 мс.
    [Fact]
    public void перерисовка_с_новыми_размерами_правит_строки_на_месте()
    {
        var vm = Fresh();
        vm.Roots = [Node("a"), Node("b")];
        vm.RenderTree();
        var rowA = vm.Rows[0];
        var changes = 0;
        vm.Rows.CollectionChanged += (_, _) => changes++;
        vm.MergeSizes([new SizeEntry("a", 10, 1, null, null)]);
        Assert.Same(rowA, vm.Rows[0]);
        Assert.Equal(0, changes); // сброс списка сбросил бы и прокрутку
        Assert.Contains("1 файлов", rowA.LocalMeta);
    }

    [Fact]
    public async Task раскрытие_папки_добавляет_её_детей_с_отступом()
    {
        var api = new FakeApi { List = rel => rel == "док" ? new ListResult([Dto("док/а.txt", false)], true, true) : new ListResult([Dto("док")], true, true) };
        var vm = Fresh(api);
        vm.LocalPath = "L";
        vm.NetworkPath = "N";
        await vm.Refresh(false);
        Assert.Single(vm.Rows);
        var верх = vm.Rows[0];
        await vm.ToggleExpand(vm.Roots[0]);
        Assert.Equal(2, vm.Rows.Count);
        Assert.Same(верх, vm.Rows[0]); // строка та же - контейнер на экране не пересоздаётся
        Assert.Equal("▾", vm.Rows[0].Caret);
        Assert.Equal(1, vm.Rows[1].Depth);
        Assert.Equal("а.txt", vm.Rows[1].Name);
    }

    [Fact]
    public void кнопка_синхронизации_только_с_выбором_и_обеими_папками()
    {
        var vm = Fresh();
        vm.Roots = [Node("a")];
        vm.ToggleCheck(Node("a"));
        Assert.False(vm.CanSync);
        vm.LocalPath = "L";
        vm.NetworkPath = "N";
        vm.UpdateControls();
        Assert.True(vm.CanSync);
    }
}
