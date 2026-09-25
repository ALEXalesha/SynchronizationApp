using System.IO;
using System.Windows;
using SyncGlass.Core.Main;
using SyncGlass.Ui;

namespace SyncGlass.Wpf;

public partial class App : Application
{
    // Папка данных - общая с Electron-версией: настройки, история, кеш размеров, место окна.
    public static string UserData { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SyncGlass");

    private InstanceLock? _lock;
    private MainWindow? _window;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Одна копия на пользователя - общая с Electron: вторая зовёт первую показаться.
        _lock = InstanceLock.TryAcquire(() => Dispatcher.BeginInvoke(() => _window?.ShowFromOtherCopy()));
        if (_lock == null)
        {
            Shutdown();
            return;
        }

        var backend = new Backend(UserData);
        backend.CleanupTempFiles();
        _window = new MainWindow();
        var vm = new MainViewModel(new BackendApi(backend, _window.PickFolder));
        _window.Attach(vm, backend);
        MainWindow = _window;
        _window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _lock?.Dispose();
        base.OnExit(e);
    }
}
