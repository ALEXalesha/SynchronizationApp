using SyncGlass.Core.Main;

namespace SyncGlass.Ui;

/// <summary>
/// Узкий мост между окном и ядром - как window.api из preload.js. Окно ходит только
/// через него, поэтому тесты подставляют поддельный, как renderer.test.js подставляет
/// заглушку window.api.
/// </summary>
public interface IApi
{
    Task<AppSettings> GetSettings();
    Task SaveSettings(AppSettings settings);
    Task<List<HistoryRun>> GetHistory();
    Task ClearHistory();
    Task<string?> PickFolder();
    Task<ProbeResult> Probe(string? localPath, string? networkPath);
    Task<ListResult> ListFolders(string? localPath, string? networkPath, string relPath, bool force, bool needMtime);
    Task<PreviewResult> Preview(SyncArgs args, IProgress<int>? progress);
    void CancelPreview();
    Task<SyncResult> Sync(SyncArgs args, IProgress<SyncProgress>? progress);
    void CancelSync();
    Task<CrawlResult> StartCrawl(string? localPath, string? networkPath, bool noLimit, ICrawlSink sink);
    void StopCrawl();
}

/// <summary>Настоящий мост: ядро плюс системное окно выбора папки от WPF.</summary>
public sealed class BackendApi(Backend backend, Func<Task<string?>> pickFolder) : IApi
{
    public Task<AppSettings> GetSettings() => backend.GetSettings();
    public Task SaveSettings(AppSettings settings) => backend.SaveSettings(settings);
    public Task<List<HistoryRun>> GetHistory() => backend.GetHistory();
    public Task ClearHistory() => backend.ClearHistory();
    public Task<string?> PickFolder() => pickFolder();
    public Task<ProbeResult> Probe(string? localPath, string? networkPath) => Task.Run(() => backend.Probe(localPath, networkPath));
    public Task<ListResult> ListFolders(string? localPath, string? networkPath, string relPath, bool force, bool needMtime)
        => Task.Run(() => backend.ListFolders(localPath, networkPath, relPath, force, needMtime));
    public Task<PreviewResult> Preview(SyncArgs args, IProgress<int>? progress) => Task.Run(() => backend.Preview(args, progress));
    public void CancelPreview() => backend.CancelPreview();
    public Task<SyncResult> Sync(SyncArgs args, IProgress<SyncProgress>? progress) => Task.Run(() => backend.Sync(args, progress));
    public void CancelSync() => backend.CancelSync();
    // Обход ждать нельзя: он идёт в фоне, окно получает размеры через sink.
    public Task<CrawlResult> StartCrawl(string? localPath, string? networkPath, bool noLimit, ICrawlSink sink)
        => Task.Run(() => backend.StartCrawl(localPath, networkPath, noLimit, sink));
    public void StopCrawl() => backend.StopCrawl();
}
