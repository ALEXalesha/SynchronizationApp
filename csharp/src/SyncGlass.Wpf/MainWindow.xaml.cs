using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using SyncGlass.Core;
using SyncGlass.Core.Main;
using SyncGlass.Ui;
using Place = SyncGlass.Core.WindowState;

namespace SyncGlass.Wpf;

/// <summary>
/// Окно: разметка и события. Всё, что решает, - в MainViewModel (перенос renderer.js);
/// здесь только клики, таймеры и место окна.
/// </summary>
public partial class MainWindow : Window
{
    private MainViewModel _vm = null!;
    private Backend? _backend;
    private readonly DispatcherTimer _probe = new() { Interval = TimeSpan.FromSeconds(6) };
    private readonly DispatcherTimer _savePlace = new() { Interval = TimeSpan.FromMilliseconds(500) };
    private static readonly Place.Options Size = new(900, 600, 900, 600);

    // Файл места окна - общий с Electron; null - не читать и не писать (снимки экрана).
    public string? PlacementFile { get; set; } = Path.Combine(App.UserData, "window-state.json");

    public MainWindow()
    {
        InitializeComponent();
        _probe.Tick += async (_, _) => await _vm.ProbeTick();
        _savePlace.Tick += (_, _) =>
        {
            _savePlace.Stop();
            SavePlacement();
        };
    }

    public void Attach(MainViewModel vm, Backend? backend)
    {
        _vm = vm;
        _backend = backend;
        DataContext = vm;
        // setTimeout из renderer.js: разовый таймер окна.
        vm.Delay = (delay, action) =>
        {
            var t = new DispatcherTimer { Interval = delay };
            t.Tick += (_, _) =>
            {
                t.Stop();
                action();
            };
            t.Start();
            return null;
        };
        Loaded += async (_, _) =>
        {
            await vm.Init();
            _probe.Start();
        };
    }

    public Task<string?> PickFolder()
    {
        var dlg = new Microsoft.Win32.OpenFolderDialog { Multiselect = false };
        return Task.FromResult(dlg.ShowDialog(this) == true ? dlg.FolderName : null);
    }

    // Вторая копия (любой из двух версий) попросила показать окно.
    public void ShowFromOtherCopy()
    {
        if (WindowState == System.Windows.WindowState.Minimized) WindowState = System.Windows.WindowState.Normal;
        Activate();
    }

    // ---- Место окна: общий с Electron window-state.json, в точках (DIP) ----

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        if (PlacementFile == null) return;
        var p = Place.Restore(Place.Load(PlacementFile), Screens(), Size);
        if (p.X is { } x && p.Y is { } y)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = x;
            Top = y;
        }
        // Место пишется после перемещения (с паузой - событие идёт на каждый шаг) и при закрытии.
        LocationChanged += (_, _) =>
        {
            _savePlace.Stop();
            _savePlace.Start();
        };
    }

    private void SavePlacement()
    {
        if (PlacementFile == null || WindowState != System.Windows.WindowState.Normal) return;
        Place.Save(PlacementFile, new Place.Placement(Math.Round(Left), Math.Round(Top), 900, 600, false));
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        SavePlacement();
        _backend?.BeforeQuit(); // прогресс обхода размеров - на диск
        base.OnClosing(e);
    }

    // Рабочие области мониторов в точках окна, основной первым.
    private List<Place.Area> Screens()
    {
        var scale = VisualTreeHelper.GetDpi(this);
        var list = new List<(Place.Area Area, bool Primary)>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr _, ref Rect32 _, IntPtr _) =>
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(monitor, ref info))
            {
                var w = info.Work;
                list.Add((new Place.Area(w.Left / scale.DpiScaleX, w.Top / scale.DpiScaleY,
                                               (w.Right - w.Left) / scale.DpiScaleX, (w.Bottom - w.Top) / scale.DpiScaleY), (info.Flags & 1) != 0));
            }
            return true;
        }, IntPtr.Zero);
        return list.OrderByDescending(m => m.Primary).Select(m => m.Area).ToList();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect32 { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public Rect32 Monitor; public Rect32 Work; public uint Flags; }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref Rect32 rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    // ---- События ----

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await _vm.Refresh(true);

    private async void History_Click(object sender, RoutedEventArgs e) => await _vm.History.Open();

    private void Dir_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { Tag: string dir } && dir != _vm.Direction) _vm.ChangeDirection(dir);
    }

    private void SizeMode_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (SizeModeBox.SelectedValue is string mode && mode != _vm.SizeMode) _vm.ChangeSizeMode(mode);
    }

    private async void Sort_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (SortBox.SelectedValue is string sort && sort != _vm.Sort) await _vm.SetSort(sort);
    }

    private async void Pick_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string side }) await _vm.PickFolder(side);
    }

    private async void Sync_Click(object sender, RoutedEventArgs e) => await _vm.Preview.Open();

    private void SelectAll_Click(object sender, RoutedEventArgs e)
    {
        var box = (CheckBox)sender;
        _vm.OnSelectAll(box.IsChecked == true);
        // Привязка односторонняя: если «все ли отмечены» не изменилось, флажок сам не вернётся.
        box.SetCurrentValue(System.Windows.Controls.Primitives.ToggleButton.IsCheckedProperty, _vm.AllChecked);
    }

    // Клик по строке на стороне-источнике переключает отметку (и у файлов тоже).
    private void Row_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is not FrameworkElement { DataContext: TreeRow { Node: { } node }, Tag: string side }) return;
        var isSource = side == "local" ? _vm.LocalIsSource : _vm.NetworkIsSource;
        if (isSource) _vm.ToggleCheck(node);
    }

    private async void Caret_Click(object sender, MouseButtonEventArgs e)
    {
        e.Handled = true; // раскрытие не должно заодно переключать отметку
        if (sender is FrameworkElement { DataContext: TreeRow { Node: { IsDir: true } node } }) await _vm.ToggleExpand(node);
    }

    private async void PreviewCancel_Click(object sender, RoutedEventArgs e) => await _vm.Preview.Cancel();

    private async void PreviewConfirm_Click(object sender, RoutedEventArgs e) => await _vm.Preview.Confirm();

    private void HistoryClose_Click(object sender, RoutedEventArgs e) => _vm.History.Close();

    private async void HistoryClear_Click(object sender, RoutedEventArgs e) => await _vm.History.Clear();

    private void HistoryRun_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: HistoryRunRow row }) _vm.History.Toggle(row);
    }
}
