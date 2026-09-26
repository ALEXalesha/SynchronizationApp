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

    // Только стили, без запуска программы - для тестов окна. Конструктор Application сам
    // ставит запуск в очередь, и без этого флага тесты занимали замок «одна копия» и
    // открывали настоящее окно на настоящих данных, а при запущенном SyncGlass приложение
    // тестов тут же закрывалось - все тесты окна падали (26.09.2026).
    public static bool StylesOnly { get; set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (StylesOnly)
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown; // тестовые окна закрываются - приложение живёт
            return;
        }
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
