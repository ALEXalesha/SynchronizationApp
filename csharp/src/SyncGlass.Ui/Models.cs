using CommunityToolkit.Mvvm.ComponentModel;
using SyncGlass.Core.Main;

namespace SyncGlass.Ui;

// Узел дерева (makeNode в renderer.js).
public sealed class TreeNode(ListItem dto)
{
    public string Name { get; set; } = dto.Name;
    public string RelPath { get; set; } = dto.RelPath;
    public bool IsDir { get; set; } = dto.IsDir;
    public bool HasLocal { get; set; } = dto.HasLocal;
    public bool HasNetwork { get; set; } = dto.HasNetwork;
    public double MtimeMs { get; set; } = dto.MtimeMs;
    public bool Loaded { get; set; }
    public bool Loading { get; set; }
    public List<TreeNode> Children { get; set; } = new();
    // Отсортированные дети с ключом сортировки - чтобы не пересортировывать большие
    // папки на каждой перерисовке.
    internal List<TreeNode>? Sorted;
    internal string? SortKey;
}

public enum Check { Unchecked, Checked, Partial }

// Отметка в дереве: настоящее написание пути и включено/исключено.
public sealed record Mark(string Path, bool Include);

// Строка дерева на экране. Обе стороны рисуются из одной строки; строки правятся на
// месте, чтобы перерисовка раз в 400 мс во время обхода не сбрасывала прокрутку.
public sealed partial class TreeRow : ObservableObject
{
    public TreeRow(string key) => Key = key;

    public string Key { get; }
    public TreeNode? Node { get; set; }

    [ObservableProperty] private int _depth;
    [ObservableProperty] private string _name = "";
    [ObservableProperty] private bool _isDir;
    [ObservableProperty] private bool _isPlaceholder;
    [ObservableProperty] private string _caret = "";
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private Check _check;
    [ObservableProperty] private bool _hasLocal;
    [ObservableProperty] private bool _hasNetwork;
    [ObservableProperty] private string _localMeta = "";
    [ObservableProperty] private bool _localDim;
    [ObservableProperty] private string _networkMeta = "";
    [ObservableProperty] private bool _networkDim;

    public double Indent => 12 + Depth * 18;
    partial void OnDepthChanged(int value) => OnPropertyChanged(nameof(Indent));

    // Для CheckBox с тремя положениями: null - «частично».
    public bool? IsChecked => Check switch { Check.Checked => true, Check.Partial => null, _ => false };
    partial void OnCheckChanged(Check value) => OnPropertyChanged(nameof(IsChecked));
}

// Плашка счётчика в предпросмотре (statNum в renderer.js).
public sealed partial class StatItem(string kind, string label) : ObservableObject
{
    public string Kind { get; } = kind;
    public string Label { get; } = label;
    [ObservableProperty] private string _value = "";
    [ObservableProperty] private string _sizeClass = "";
    [ObservableProperty] private string? _of;

    public void Set(long value, long? total = null)
    {
        Value = Format.FmtNum(value);
        SizeClass = Format.NumSize(Value);
        Of = total is { } t ? "из " + Format.FmtNum(t) : null;
    }
}

// Строка под счётчиками: пояснение (Note), предупреждение (Warn) или сообщение вместо
// счётчиков (Empty) - «Сканирую выбранное…», ошибки.
public sealed record Notice(string Kind, string Text);

public sealed record PreviewRow(string Folder, string Counts, bool IsHead = false, bool IsMore = false);

public sealed record Part(string Kind, string Text);

public sealed partial class HistoryRunRow : ObservableObject
{
    public required HistoryRun Run { get; init; }
    public required string Time { get; init; }
    public required string Dir { get; init; }
    public required List<Part> Counts { get; init; }
    public required List<Part> Badges { get; init; }
    [ObservableProperty] private bool _isExpanded;
    [ObservableProperty] private List<Part>? _files;
    public string Caret => IsExpanded ? "▾" : "▸";
    partial void OnIsExpandedChanged(bool value) => OnPropertyChanged(nameof(Caret));
}
