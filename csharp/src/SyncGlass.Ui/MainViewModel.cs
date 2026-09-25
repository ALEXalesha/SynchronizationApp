using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using SyncGlass.Core;
using SyncGlass.Core.Main;

namespace SyncGlass.Ui;

/// <summary>
/// Перенос renderer/renderer.js: состояние окна, трёхпозиционный выбор, дерево,
/// размеры, статус, проверка связи. Предпросмотр и история - в соседних частях класса.
/// Полные «почему» (все - про найденные баги) - в комментариях renderer.js.
/// </summary>
public sealed partial class MainViewModel : ObservableObject, ICrawlSink
{
    private readonly IApi _api;
    private readonly Action<Action> _post;

    // Отложенный вызов (setTimeout): окно подставляет таймер, тесты - немедленный вызов.
    public Func<TimeSpan, Action, IDisposable?> Delay { get; set; } = (_, a) =>
    {
        a();
        return null;
    };

    public MainViewModel(IApi api)
    {
        _api = api;
        // События обхода приходят из фона - в окно их переносит контекст окна.
        var ctx = SynchronizationContext.Current;
        _post = ctx != null ? a => ctx.Post(_ => a(), null) : a => a();
        Preview = new PreviewModel(this);
        History = new HistoryModel(this);
    }

    public PreviewModel Preview { get; }
    public HistoryModel History { get; }

    // ---- Состояние ----
    [ObservableProperty] private string _localPath = "";
    [ObservableProperty] private string _networkPath = "";
    [ObservableProperty] private string _direction = "toNetwork"; // toNetwork | toLocal
    [ObservableProperty] private string _sort = "name";           // name | date
    [ObservableProperty] private string _sizeMode = "capped";     // off | capped | full

    public List<TreeNode> Roots { get; set; } = new();
    public Dictionary<string, Mark> Marks { get; private set; } = new(StringComparer.Ordinal);
    public HashSet<string> Expanded { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, SizeEntry> SizeMap { get; } = new(StringComparer.Ordinal);
    private int _scanGen;
    public bool? LocalOk { get; set; }
    public bool? NetworkOk { get; set; }

    public string LocalPathLabel => LocalPath != "" ? LocalPath : "путь не выбран";
    public string NetworkPathLabel => NetworkPath != "" ? NetworkPath : "путь не выбран";
    partial void OnLocalPathChanged(string value) => OnPropertyChanged(nameof(LocalPathLabel));
    partial void OnNetworkPathChanged(string value) => OnPropertyChanged(nameof(NetworkPathLabel));

    // Сторона-источник: там чекбоксы, «Выбрать все» и счётчик; на другой - подсказка.
    public bool LocalIsSource => Direction == "toNetwork";
    public bool NetworkIsSource => Direction != "toNetwork";
    partial void OnDirectionChanged(string value)
    {
        OnPropertyChanged(nameof(LocalIsSource));
        OnPropertyChanged(nameof(NetworkIsSource));
    }

    // ---- Статус-бар ----
    [ObservableProperty] private string _statusKind = "idle"; // busy | done | idle | error
    [ObservableProperty] private string _statusText = "Выберите папки внизу";
    [ObservableProperty] private string _statusSummary = "";

    public bool StatusBusy => StatusKind == "busy";
    partial void OnStatusKindChanged(string value) => OnPropertyChanged(nameof(StatusBusy));

    public void SetStatus(string kind, string text, string summary = "")
    {
        StatusKind = kind;
        StatusText = text;
        StatusSummary = summary;
    }

    // Точки связи: null - пути нет, true/false - доступно/недоступно.
    [ObservableProperty] private bool? _localConn;
    [ObservableProperty] private bool? _networkConn;

    // ---- Дерево на экране ----
    public ObservableCollection<TreeRow> Rows { get; } = new();
    [ObservableProperty] private string? _emptyText = "Выберите папки внизу";
    [ObservableProperty] private string _selectedCountText = "выбрано: 0";
    [ObservableProperty] private bool _allChecked;
    [ObservableProperty] private bool _canSync;

    // Сколько раз дерево перерисовывалось - тесты проверяют лишние и недостающие перерисовки.
    public int RenderCount { get; private set; }

    // ---- Модель выбора (трёхпозиционная) ----
    // Ключ отметки - путь без учёта регистра: вторая сторона могла написать имя иначе.
    public static string MarkKey(string relPath) => Paths.CiKey(relPath);
    public static string ExpandKey(string relPath) => Paths.CiKey(relPath);
    public bool IsExpanded(string relPath) => Expanded.Contains(ExpandKey(relPath));

    public bool InheritedIncluded(string relPath)
    {
        var parts = relPath.Split('/');
        for (var i = parts.Length - 1; i >= 1; i--)
        {
            if (Marks.TryGetValue(MarkKey(string.Join('/', parts, 0, i)), out var m)) return m.Include;
        }
        return false;
    }

    public bool IsIncluded(string relPath)
        => Marks.TryGetValue(MarkKey(relPath), out var m) ? m.Include : InheritedIncluded(relPath);

    // Все правки отметок идут через эти три метода: на них построен запомненный ответ
    // «внутри есть отметки».
    private HashSet<string>? _markParents;
    private void SetMark(string key, Mark entry)
    {
        Marks[key] = entry;
        _markParents = null;
    }
    private void DeleteMark(string key)
    {
        Marks.Remove(key);
        _markParents = null;
    }
    private void ReplaceMarks(Dictionary<string, Mark> next)
    {
        Marks = next;
        _markParents = null;
    }

    // Ключи всех папок, внутри которых лежит хоть одна отметка - один раз на правку
    // выбора, а не перебором отметок на каждую строку.
    private HashSet<string> MarkParentKeys()
    {
        if (_markParents != null) return _markParents;
        _markParents = new HashSet<string>(StringComparer.Ordinal);
        foreach (var k in Marks.Keys)
        {
            var cut = k.LastIndexOf('/');
            while (cut > 0)
            {
                var parent = k[..cut];
                if (!_markParents.Add(parent)) break; // выше уже размечено этой же цепочкой
                cut = parent.LastIndexOf('/');
            }
        }
        return _markParents;
    }

    public bool HasDescendantMark(string relPath) => MarkParentKeys().Contains(MarkKey(relPath));

    public Check NodeCheckState(string relPath)
    {
        if (HasDescendantMark(relPath)) return Check.Partial;
        return IsIncluded(relPath) ? Check.Checked : Check.Unchecked;
    }

    public (List<string> Folders, List<string> Excludes) CollectSelection()
    {
        var folders = new List<string>();
        var excludes = new List<string>();
        foreach (var e in Marks.Values) (e.Include ? folders : excludes).Add(e.Path);
        return (folders, excludes);
    }

    // Клик переключает включённость целиком; работает и для файлов. Узел с отметками
    // внутри рисуется чёрточкой, и клик по чёрточке всегда включает ветку целиком.
    public void ToggleCheck(TreeNode node) => ToggleCheck(node.RelPath);

    public void ToggleCheck(string rel)
    {
        var key = MarkKey(rel);
        var want = HasDescendantMark(rel) || !IsIncluded(rel);
        var inherited = InheritedIncluded(rel);
        var prefix = key + "/";
        foreach (var k in Marks.Keys.Where(k => k != key && k.StartsWith(prefix, StringComparison.Ordinal)).ToList()) DeleteMark(k);
        if (want == inherited) DeleteMark(key);
        else SetMark(key, new Mark(rel, want));
        RenderTree();
    }

    public void OnSelectAll(bool check)
    {
        var next = new Dictionary<string, Mark>(StringComparer.Ordinal);
        if (check) foreach (var n in Roots) next[MarkKey(n.RelPath)] = new Mark(n.RelPath, true);
        ReplaceMarks(next);
        RenderTree();
    }

    // Убирает отметки папок, которых больше нет на верхнем уровне - только по достоверному
    // списку (моргнувшая связь не должна стирать выбор). Написание корня подгоняется
    // под текущий список; режем по настоящему пути, а не по ключу.
    public void PruneMarks(bool localOk, bool networkOk)
    {
        if (LocalPath != "" && !localOk) return;
        if (NetworkPath != "" && !networkOk) return;
        var byLower = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var n in Roots) byLower[MarkKey(n.RelPath)] = n.RelPath;
        var kept = new Dictionary<string, Mark>(StringComparer.Ordinal);
        foreach (var entry in Marks.Values)
        {
            var slash = entry.Path.IndexOf('/');
            var head = slash < 0 ? entry.Path : entry.Path[..slash];
            if (!byLower.TryGetValue(MarkKey(head), out var actual)) continue; // папки больше нет
            var relPath = actual + entry.Path[head.Length..];
            kept[MarkKey(relPath)] = new Mark(relPath, entry.Include);
        }
        ReplaceMarks(kept);
    }

    // ---- Настройки ----
    private void Persist()
        => _ = _api.SaveSettings(new AppSettings { LocalPath = LocalPath, NetworkPath = NetworkPath, Direction = Direction, Sort = Sort, SizeMode = SizeMode });

    private void StartCrawlIfEnabled()
    {
        if (SizeMode == "off")
        {
            SetStatus("idle", "Размеры отключены");
            return;
        }
        SetStatus("busy", "Загрузка размеров и файлов…", "");
        _ = _api.StartCrawl(LocalPath, NetworkPath, SizeMode == "full", this);
    }

    // ---- Сортировка: папки всегда сверху, внутри - по имени или по дате (новые сверху) ----
    public List<TreeNode> SortNodes(IEnumerable<TreeNode> nodes)
    {
        var dirsFirst = nodes.OrderBy(n => n.IsDir ? 0 : 1);
        return (Sort == "date"
            ? dirsFirst.ThenByDescending(n => n.MtimeMs)
            : dirsFirst.ThenBy(n => n.Name, StringComparer.Create(CultureInfo.CurrentCulture, false))).ToList();
    }

    private List<TreeNode> SortedChildren(TreeNode node)
    {
        if (node.SortKey != Sort || node.Sorted == null)
        {
            node.Sorted = SortNodes(node.Children);
            node.SortKey = Sort;
        }
        return node.Sorted;
    }

    private List<TreeNode>? _sortedRoots;
    private string? _sortedRootsKey;
    private List<TreeNode> SortedRoots()
    {
        if (_sortedRootsKey != Sort || _sortedRoots == null)
        {
            _sortedRoots = SortNodes(Roots);
            _sortedRootsKey = Sort;
        }
        return _sortedRoots;
    }
    private void InvalidateRootSort() => _sortedRoots = null;

    public async Task SetSort(string value)
    {
        var prev = Sort;
        Sort = value;
        Persist();
        // Для сортировки по дате нужно подтянуть даты (по имени они не грузятся).
        if (Sort == "date" && prev != "date") await Refresh(false);
        else RenderTree();
    }

    // ---- Выбор путей ----
    public async Task PickFolder(string side)
    {
        var dir = await _api.PickFolder();
        if (string.IsNullOrEmpty(dir)) return;
        SetPath(side, dir);
        SizeMap.Clear(); // путь сменился - старые размеры не годятся
        ReplaceMarks(new Dictionary<string, Mark>(StringComparer.Ordinal));
        Persist();
        await Refresh(true);
    }

    public void SetPath(string side, string dir)
    {
        if (side == "local") LocalPath = dir;
        else NetworkPath = dir;
    }

    public void SetDirection(string dir)
    {
        Direction = dir;
        RenderTree(); // чекбоксы переезжают на сторону-источник
    }

    public void ChangeDirection(string dir)
    {
        SetDirection(dir);
        Persist();
    }

    // ---- Загрузка дерева ----
    public async Task Refresh(bool force)
    {
        if (LocalPath == "" && NetworkPath == "") return;
        var gen = ++_scanGen;
        Expanded.Clear();
        SetStatus("busy", "Читаю список папок…");
        ListResult listing;
        try
        {
            listing = await _api.ListFolders(LocalPath, NetworkPath, "", force, Sort == "date");
        }
        catch (Exception err)
        {
            SetStatus("error", "Не удалось прочитать папки", err.Message);
            return;
        }
        if (gen != _scanGen) return;
        Roots = listing.Items.Select(i => new TreeNode(i)).ToList();
        InvalidateRootSort();
        PruneMarks(listing.LocalOk, listing.NetworkOk);
        RenderTree();
        StartCrawlIfEnabled(); // фоновая загрузка размеров не блокирует окно
    }

    public void ChangeSizeMode(string mode)
    {
        SizeMode = mode;
        Persist();
        _api.StopCrawl(); // гасим текущий обход
        if (SizeMode == "off")
        {
            SizeMap.Clear();
            SetStatus("idle", "Размеры отключены");
            RenderTree();
        }
        else StartCrawlIfEnabled();
    }

    public async Task LoadChildren(TreeNode node)
    {
        if (node.Loaded || node.Loading) return;
        node.Loading = true;
        RenderTree();
        try
        {
            var r = await _api.ListFolders(LocalPath, NetworkPath, node.RelPath, false, Sort == "date");
            node.Children = r.Items.Select(i => new TreeNode(i)).ToList();
            node.Sorted = null;
            node.Loaded = true;
        }
        catch
        {
            // Запрос не дошёл: ветка остаётся нераскрытой - следующий клик попробует снова.
            Expanded.Remove(ExpandKey(node.RelPath));
        }
        finally
        {
            node.Loading = false;
        }
        RenderTree();
    }

    public async Task ToggleExpand(TreeNode node)
    {
        if (!node.IsDir) return;
        if (IsExpanded(node.RelPath))
        {
            Expanded.Remove(ExpandKey(node.RelPath));
            RenderTree();
            return;
        }
        Expanded.Add(ExpandKey(node.RelPath));
        if (!node.Loaded) await LoadChildren(node);
        else RenderTree();
    }

    // ---- Отрисовка дерева ----
    public const int ChildLimit = 500;

    private sealed record RowData(string Key, TreeNode? Node, int Depth, string? Placeholder);

    public void RenderTree()
    {
        RenderCount++;
        var data = new List<RowData>();
        if (Roots.Count == 0)
        {
            EmptyText = LocalPath != "" || NetworkPath != "" ? "Папок не найдено" : "Выберите папки внизу";
        }
        else
        {
            EmptyText = null;
            // Верхний уровень режем тем же пределом, что и вложенные.
            var roots = SortedRoots();
            Walk(roots.Take(ChildLimit), 0, data);
            if (roots.Count > ChildLimit)
                data.Add(new RowData("…root", null, 0, $"…ещё {Format.FmtNum(roots.Count - ChildLimit)} (не показаны)"));
        }
        SyncRows(data);
        UpdateControls();
    }

    private void Walk(IEnumerable<TreeNode> sorted, int depth, List<RowData> data)
    {
        foreach (var node in sorted)
        {
            data.Add(new RowData(MarkKey(node.RelPath), node, depth, null));
            if (!node.IsDir || !IsExpanded(node.RelPath) || !node.Loaded) continue;
            if (node.Children.Count == 0)
            {
                data.Add(new RowData(MarkKey(node.RelPath) + "/…empty", null, depth + 1, "(пусто)"));
                continue;
            }
            var kids = SortedChildren(node);
            Walk(kids.Take(ChildLimit), depth + 1, data);
            var hidden = kids.Count - Math.Min(kids.Count, ChildLimit);
            if (hidden > 0) data.Add(new RowData(MarkKey(node.RelPath) + "/…more", null, depth + 1, $"…ещё {hidden}"));
        }
    }

    // Строки правятся на месте: тот же ключ - та же строка, меняются только свойства.
    // Пересоздание всех строк сбрасывало бы прокрутку на каждой перерисовке.
    private void SyncRows(List<RowData> data)
    {
        var sameShape = data.Count == Rows.Count;
        for (var i = 0; sameShape && i < data.Count; i++) sameShape = Rows[i].Key == data[i].Key;
        if (!sameShape)
        {
            var old = Rows.ToDictionary(r => r.Key, StringComparer.Ordinal);
            Rows.Clear();
            foreach (var d in data) Rows.Add(old.TryGetValue(d.Key, out var r) ? r : new TreeRow(d.Key));
        }
        for (var i = 0; i < data.Count; i++) Fill(Rows[i], data[i]);
    }

    private void Fill(TreeRow row, RowData d)
    {
        row.Depth = d.Depth;
        row.Node = d.Node;
        if (d.Node is not { } node)
        {
            row.IsPlaceholder = true;
            row.Name = d.Placeholder ?? "";
            row.Caret = "";
            row.IsDir = false;
            return;
        }
        row.IsPlaceholder = false;
        row.Name = node.Name;
        row.IsDir = node.IsDir;
        row.IsLoading = node.IsDir && node.Loading;
        row.Caret = !node.IsDir || node.Loading ? "" : IsExpanded(node.RelPath) ? "▾" : "▸";
        row.Check = NodeCheckState(node.RelPath);
        row.HasLocal = node.HasLocal;
        row.HasNetwork = node.HasNetwork;
        (row.LocalMeta, row.LocalDim) = MetaFor(node, "local");
        (row.NetworkMeta, row.NetworkDim) = MetaFor(node, "network");
    }

    // Текст метаданных строки (размер и счёт) для стороны.
    public (string Text, bool Dim) MetaFor(TreeNode node, string side)
    {
        var present = side == "local" ? node.HasLocal : node.HasNetwork;
        if (!present) return (side == "local" ? "нет локально" : "нет в сети", true);
        if (!SizeMap.TryGetValue(MarkKey(node.RelPath), out var s)) return ("", true);
        var size = side == "local" ? s.SizeLocal : s.SizeNetwork;
        var cnt = side == "local" ? s.CntLocal : s.CntNetwork;
        if (size == null) return ("", true);
        if (node.IsDir) return ($"{Format.FmtNum(cnt ?? 0)} файлов · {Format.FormatSize(size)}", false);
        return (Format.FormatSize(size), false);
    }

    public void UpdateControls()
    {
        var (folders, excludes) = CollectSelection();
        var exNote = excludes.Count > 0 ? $", исключено: {excludes.Count}" : "";
        SelectedCountText = $"выбрано: {folders.Count}{exNote}";
        AllChecked = Roots.Count > 0 && Roots.All(n => Marks.TryGetValue(MarkKey(n.RelPath), out var m) && m.Include);
        CanSync = folders.Count > 0 && LocalPath != "" && NetworkPath != "";
    }

    // ---- Приём результатов фонового обхода ----
    private IDisposable? _sizeTimer;
    private bool _sizePending;

    private void ScheduleSizeRender()
    {
        if (_sizePending) return;
        _sizePending = true;
        _sizeTimer = Delay(TimeSpan.FromMilliseconds(400), () =>
        {
            _sizePending = false;
            _sizeTimer = null;
            RenderTree();
        });
    }

    // Ключ - тот же, что у отметок: без учёта регистра.
    public void MergeSizes(IEnumerable<SizeEntry> entries)
    {
        foreach (var e in entries)
        {
            var key = MarkKey(e.RelPath);
            SizeMap.TryGetValue(key, out var cur);
            cur ??= new SizeEntry(e.RelPath, null, null, null, null);
            if (e.SizeLocal != null) cur = cur with { SizeLocal = e.SizeLocal, CntLocal = e.CntLocal };
            if (e.SizeNetwork != null) cur = cur with { SizeNetwork = e.SizeNetwork, CntNetwork = e.CntNetwork };
            SizeMap[key] = cur;
        }
        ScheduleSizeRender();
    }

    void ICrawlSink.Cached(List<SizeEntry> entries) => _post(() => MergeSizes(entries));

    void ICrawlSink.Progress(int scanned, List<SizeEntry> entries) => _post(() =>
    {
        MergeSizes(entries);
        SetStatus("busy", "Загрузка размеров и файлов…", $"{Format.FmtNum(scanned)} объектов");
    });

    void ICrawlSink.Done(CrawlDone d) => _post(() =>
    {
        // partial - сторона пропала посреди обхода: размеры неполные, и «Готово» выдало бы
        // их за полную картину. noAccess - папки на месте, но внутрь не пускают.
        var n = $"{Format.FmtNum(d.Scanned)} объектов";
        if (d.Ok && !d.Partial && d.NoAccess > 0) SetStatus("done", $"Готово, {d.NoAccess} папок и файлов без доступа", n);
        else if (d.Ok && d.Partial) SetStatus("error", "Связь оборвалась — размеры неполные, нажмите «Обновить»", n);
        else if (d.Ok) SetStatus("done", "Готово", n);
        else if (d.TooBig) SetStatus("error", "Слишком много файлов — подсчёт размеров остановлен", $"{Format.FmtNum(d.Scanned)}+");
        else SetStatus("error", "Не удалось загрузить размеры");
        RenderTree();
    });

    // ---- Постоянная проверка доступности папок ----

    // Лёгкое обновление верхнего уровня без сброса дерева и размеров. Узлы ищутся по ключу
    // без учёта регистра и переиспользуются: раскрытая ветка не схлопывается, когда
    // вернувшаяся сторона пишет имя иначе. В признак изменения входит и само написание.
    public async Task LightRelistTop()
    {
        if (LocalPath == "" && NetworkPath == "") return;
        var listing = await _api.ListFolders(LocalPath, NetworkPath, "", false, Sort == "date");
        // Сторона не прочиталась - её папки выглядят пропавшими; такой картине не верим.
        if (LocalPath != "" && !listing.LocalOk) return;
        if (NetworkPath != "" && !listing.NetworkOk) return;

        string Sig(IEnumerable<TreeNode> arr) => string.Join("|", arr.Select(n =>
            $"{n.RelPath}:{(n.HasLocal ? 1 : 0)}{(n.HasNetwork ? 1 : 0)}" + (Sort == "date" ? $":{n.MtimeMs}" : "")));
        var oldSig = Sig(Roots);
        var byRel = new Dictionary<string, TreeNode>(StringComparer.Ordinal);
        foreach (var n in Roots) byRel[MarkKey(n.RelPath)] = n;
        Roots = listing.Items.Select(it =>
        {
            if (!byRel.TryGetValue(MarkKey(it.RelPath), out var ex)) return new TreeNode(it);
            ex.Name = it.Name; // написание подтягиваем за листингом
            ex.RelPath = it.RelPath;
            ex.IsDir = it.IsDir;
            ex.HasLocal = it.HasLocal;
            ex.HasNetwork = it.HasNetwork;
            ex.MtimeMs = it.MtimeMs;
            return ex;
        }).ToList();
        InvalidateRootSort();
        PruneMarks(listing.LocalOk, listing.NetworkOk);
        if (oldSig != Sig(Roots)) RenderTree();
        else UpdateControls();
    }

    private bool _probing;

    public async Task ProbeTick()
    {
        if (_probing || (LocalPath == "" && NetworkPath == "")) return;
        _probing = true;
        try
        {
            var r = await _api.Probe(LocalPath, NetworkPath);
            LocalConn = LocalPath != "" ? r.LocalOk : null;
            NetworkConn = NetworkPath != "" ? r.NetworkOk : null;
            var changed = (NetworkOk != null && r.NetworkOk != NetworkOk) || (LocalOk != null && r.LocalOk != LocalOk);
            NetworkOk = r.NetworkOk;
            LocalOk = r.LocalOk;

            // Пока открыт предпросмотр, дерево под ним не видно, а сеть общая: обход
            // размеров встал бы вторым потоком поперёк синхронизации.
            if (Preview.IsOpen) return;
            if (changed) await Refresh(true); // связь появилась или пропала
            else if (r.LocalOk || r.NetworkOk) await LightRelistTop();
        }
        catch
        {
            // сбой запроса - не критично, повторим на следующем тике
        }
        finally
        {
            _probing = false;
        }
    }

    // ---- Старт ----
    public async Task Init()
    {
        var s = await _api.GetSettings();
        if (s.Sort is "name" or "date") Sort = s.Sort;
        if (s.SizeMode is "off" or "capped" or "full") SizeMode = s.SizeMode;
        else if (s.Other != null && s.Other.TryGetValue("showSizes", out var show) && show.ValueKind == System.Text.Json.JsonValueKind.False)
            SizeMode = "off"; // миграция со старой настройки
        if (s.Direction is "toNetwork" or "toLocal") SetDirection(s.Direction);
        if (!string.IsNullOrEmpty(s.LocalPath)) SetPath("local", s.LocalPath);
        if (!string.IsNullOrEmpty(s.NetworkPath)) SetPath("network", s.NetworkPath);
        if (LocalPath != "" || NetworkPath != "") await Refresh(true);
        else RenderTree();
        await ProbeTick();
    }

    // Для предпросмотра и истории.
    internal IApi Api => _api;
    internal SyncArgs Args()
    {
        var (folders, excludes) = CollectSelection();
        return new SyncArgs(LocalPath, NetworkPath, folders, excludes, Direction);
    }
}
