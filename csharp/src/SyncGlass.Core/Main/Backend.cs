using System.Diagnostics;
using SyncOps = SyncGlass.Core.Sync;

namespace SyncGlass.Core.Main;

public sealed record SyncArgs(string? LocalPath, string? NetworkPath, IReadOnlyList<string> Folders, IReadOnlyList<string> Excludes, string Direction);

public sealed record ListItem(string Name, string RelPath, bool IsDir, bool HasLocal, bool HasNetwork, double MtimeMs);

public sealed record ListResult(List<ListItem> Items, bool LocalOk, bool NetworkOk);

public sealed record ProbeResult(bool LocalOk, bool NetworkOk);

public sealed record PreviewResult(List<FolderCount>? PerFolder = null, Summary? Totals = null, List<string>? Skipped = null,
                                   int SkippedTotal = 0, bool Aborted = false, string? Error = null);

public sealed record SyncProgress(int Done, int Total, string Action, string Path, IReadOnlyDictionary<string, int> By);

public sealed record SyncResult(int Done = 0, int Total = 0, int Unrecoverable = 0, int Failures = 0, List<string>? FailuresSample = null,
                                int SkippedTotal = 0, bool Cancelled = false, string? Error = null, bool Started = false);

public sealed record CrawlDone(int Scanned, bool Ok, bool Partial = false, int NoAccess = 0, bool TooBig = false, string? Error = null);

public sealed record CrawlResult(bool Ok, int Scanned = 0, bool Partial = false, int NoAccess = 0, bool Aborted = false, bool TooBig = false, string? Error = null);

// Куда обход отправляет размеры: события crawl-cached / crawl-progress / crawl-done.
public interface ICrawlSink
{
    void Cached(List<SizeEntry> entries);
    void Progress(int scanned, List<SizeEntry> entries);
    void Done(CrawlDone done);
}

/// <summary>
/// Перенос main.js без окна: 13 обработчиков IPC - методы с теми же именами.
/// Полные объяснения «почему» (все - про найденные баги) - в комментариях main.js.
/// </summary>
public sealed class Backend
{
    // Скан живёт ограниченное время: окно, открытое с утра, к вечеру описывает диск,
    // которого уже нет.
    public static readonly TimeSpan ScanTtl = TimeSpan.FromMinutes(15);
    // Предохранитель обхода размеров: на очень больших деревьях подсчёт останавливается.
    public const int MaxCrawl = 300000;

    public string UserData { get; }
    public SettingsStore Settings { get; }
    public HistoryStore History { get; }
    public SizeCacheStore SizeCache { get; }

    // Тесты подменяют часы, чтобы проверить срок жизни сканов и индекса без ожидания.
    internal Func<DateTime> Now { get; set; } = () => DateTime.UtcNow;

    public Backend(string userData)
    {
        UserData = userData;
        Directory.CreateDirectory(userData);
        Settings = new SettingsStore(userData);
        History = new HistoryStore(userData);
        SizeCache = new SizeCacheStore(userData);
    }

    public Task<AppSettings> GetSettings() => Settings.Load();
    public Task SaveSettings(AppSettings s) => Settings.Save(s);
    public async Task<List<HistoryRun>> GetHistory() => HistoryStore.TrimDetails(await History.Load());
    public Task ClearHistory() => History.Clear();
    public void CleanupTempFiles() => SizeCache.CleanupTempFiles();

    // ---- Кеш сканов: ключ (путь + исключения) → файлы, папки, закрытое ----

    private sealed record Scan(List<FileEntry> Files, List<string> Dirs, List<string> Skipped, DateTime At);

    private readonly object _gate = new();
    private readonly Dictionary<string, Scan> _scanCache = new(StringComparer.Ordinal);

    private static string CacheKey(string abs, IReadOnlyCollection<string>? excludes)
        => excludes == null || excludes.Count == 0 ? abs : abs + "\0" + string.Join("\0", excludes.OrderBy(e => e, StringComparer.Ordinal));

    // Выбрасывает записи, которым по возрасту уже нельзя верить: за долгую сессию
    // разных ключей набирается сколько угодно, и ни один не освобождался.
    private void PruneScanCache(DateTime now)
    {
        foreach (var key in _scanCache.Where(kv => now - kv.Value.At >= ScanTtl).Select(kv => kv.Key).ToList())
            _scanCache.Remove(key);
    }

    private async Task<ScanResult> GetScan(string abs, IReadOnlyCollection<string>? excludes, Action? onFile)
    {
        var key = CacheKey(abs, excludes);
        lock (_gate)
        {
            if (_scanCache.TryGetValue(key, out var hit) && Now() - hit.At < ScanTtl)
                return new ScanResult(hit.Files, hit.Dirs, hit.Skipped);
        }
        var dirs = new List<string>();
        var skipped = new List<string>();
        var files = await FsOps.ScanFiles(abs, "", null, excludes, onFile, dirs, skipped);
        lock (_gate)
        {
            var now = Now();
            PruneScanCache(now);
            _scanCache[key] = new Scan(files, dirs, skipped, now);
        }
        return new ScanResult(files, dirs, skipped);
    }

    // ---- Индекс фонового обхода ----

    private sealed class CrawlData
    {
        public string? LocalPath, NetworkPath;
        public readonly Dictionary<string, (long Size, double MtimeMs)> Local = new(StringComparer.Ordinal), Network = new(StringComparer.Ordinal);
        public readonly HashSet<string> LocalDirs = new(StringComparer.Ordinal), NetworkDirs = new(StringComparer.Ordinal);
        public readonly List<string> LocalSkipped = new(), NetworkSkipped = new();
        public bool Complete;
        public DateTime At;
    }

    private CrawlData? _crawlData;
    private int _crawlToken;

    // Индекс стороны root из завершённого и не просроченного обхода, иначе null: он
    // подменяет живой скан, а значит стареет так же.
    private CrawlSide? CrawlSideFor(string root)
    {
        lock (_gate)
        {
            var d = _crawlData;
            if (d == null || !d.Complete || Now() - d.At > ScanTtl) return null;
            if (root == d.LocalPath) return new CrawlSide(d.Local, d.LocalDirs, d.LocalSkipped);
            if (root == d.NetworkPath) return new CrawlSide(d.Network, d.NetworkDirs, d.NetworkSkipped);
            return null;
        }
    }

    private void DropCaches()
    {
        lock (_gate)
        {
            _scanCache.Clear();
            _crawlData = null;
        }
    }

    // Сканер ветки: из индекса обхода, иначе живой скан. Раскладка индекса и исключений
    // по веткам - один раз на запуск (иначе ветки × индекс и ветки × исключения).
    private Scanner MakeScanner(Action? onFile, IReadOnlyList<string>? folders)
    {
        var bySide = new Dictionary<string, Dictionary<string, ScanResult>>(StringComparer.Ordinal);
        Dictionary<string, HashSet<string>>? excludesByBranch = null;
        var sync = new object();
        return async (root, branch, excludes) =>
        {
            var idx = CrawlSideFor(root);
            if (idx != null)
            {
                if (folders == null) return Plan.ScanFromIndex(idx, branch, excludes);
                Dictionary<string, ScanResult>? groups;
                lock (sync)
                {
                    if (!bySide.TryGetValue(root, out groups)) bySide[root] = groups = Plan.GroupIndexByBranch(idx, folders, excludes);
                }
                return groups.TryGetValue(Paths.CiKey(branch), out var g) ? g : ScanResult.Empty();
            }
            HashSet<string> branchExcludes;
            lock (sync)
            {
                excludesByBranch ??= Plan.GroupExcludesByBranch(excludes);
                branchExcludes = excludesByBranch.GetValueOrDefault(Paths.CiKey(branch)) ?? new HashSet<string>();
            }
            return await GetScan(Path.Join(root, branch), branchExcludes, onFile);
        };
    }

    // ---- Доступность сторон ----

    private static bool IsDir(string? p)
    {
        if (string.IsNullOrEmpty(p)) return false;
        try { return Directory.Exists(p); } catch { return false; }
    }

    // Обе стороны на месте, прежде чем строить план: оборванная сеть даёт пустой
    // источник, а пустой источник означает «на приёмнике всё лишнее».
    private static void AssertRootsReachable(string? srcRoot, string? dstRoot)
    {
        if (!IsDir(srcRoot)) throw new InvalidOperationException($"папка-источник недоступна ({(string.IsNullOrEmpty(srcRoot) ? "не выбрана" : srcRoot)})");
        if (!IsDir(dstRoot)) throw new InvalidOperationException($"папка-приёмник недоступна ({(string.IsNullOrEmpty(dstRoot) ? "не выбрана" : dstRoot)})");
        if (Paths.RootsOverlap(srcRoot!, dstRoot!)) throw new InvalidOperationException("папки вложены друг в друга — выберите непересекающиеся");
    }

    public Task<ProbeResult> Probe(string? localPath, string? networkPath)
        => Task.FromResult(new ProbeResult(IsDir(localPath), IsDir(networkPath)));

    // Ленивый листинг прямых детей уровня relPath: объединение сторон по имени без
    // регистра, помечая присутствие. force - «Обновить»: сбросить сканы и индекс.
    // Достоверность списка берём у самого листинга (Ok=false), а не у отдельной
    // проверки папки: та проходит по закрытой правами папке, а чтение - нет.
    public async Task<ListResult> ListFolders(string? localPath, string? networkPath, string relPath = "", bool force = false, bool needMtime = false)
    {
        if (force) DropCaches();
        var localT = localPath != null && localPath != "" ? FsOps.ListChildren(Path.Join(localPath, relPath), needMtime) : Task.FromResult((new List<ChildItem>(), false));
        var networkT = networkPath != null && networkPath != "" ? FsOps.ListChildren(Path.Join(networkPath, relPath), needMtime) : Task.FromResult((new List<ChildItem>(), false));
        var local = await localT;
        var network = await networkT;

        var map = new Dictionary<string, (string Name, bool IsDir, bool HasLocal, bool HasNetwork, double Mtime)>(StringComparer.Ordinal);
        var order = new List<string>();
        void Merge(List<ChildItem> items, bool localSide)
        {
            foreach (var e in items)
            {
                var key = Paths.CiKey(e.Name);
                if (!map.TryGetValue(key, out var m))
                {
                    m = (e.Name, false, false, false, 0);
                    order.Add(key);
                }
                m.IsDir = m.IsDir || e.IsDir;
                if (localSide) m.HasLocal = true;
                else m.HasNetwork = true;
                if (e.MtimeMs > m.Mtime) m.Mtime = e.MtimeMs; // более свежая сторона
                map[key] = m;
            }
        }
        Merge(local.Item1, true);
        Merge(network.Item1, false);

        // Сначала папки, потом файлы; внутри - по имени, как localeCompare.
        var cmp = StringComparer.Create(System.Globalization.CultureInfo.CurrentCulture, false);
        var items = order.Select(k => map[k])
            .OrderBy(m => m.IsDir ? 0 : 1).ThenBy(m => m.Name, cmp)
            .Select(m => new ListItem(m.Name, relPath != "" ? $"{relPath}/{m.Name}" : m.Name, m.IsDir, m.HasLocal, m.HasNetwork, m.Mtime))
            .ToList();
        return new ListResult(items, local.Item2, network.Item2);
    }

    // ---- Фоновый обход: размеры и количество файлов ----

    private sealed class SizeRow(string relPath)
    {
        public readonly string RelPath = relPath;
        public long? SizeLocal, SizeNetwork;
        public int? CntLocal, CntNetwork;
        public SizeEntry Snapshot() => new(RelPath, SizeLocal, CntLocal, SizeNetwork, CntNetwork);
    }

    // Index пишут работники обхода под замком Lock - под ним же его читает BeforeQuit.
    private sealed class ActiveCrawl(Dictionary<string, SizeRow> index, object lockObj, string? localPath, string? networkPath)
    {
        public readonly Dictionary<string, SizeRow> Index = index;
        public readonly object Lock = lockObj;
        public readonly string? LocalPath = localPath, NetworkPath = networkPath;
    }

    private ActiveCrawl? _activeCrawl;

    private sealed class CrawlAborted : Exception;
    private sealed class CrawlTooBig : Exception;

    public void StopCrawl()
    {
        lock (_gate)
        {
            _crawlToken++;
            // Остановленный обход обновлять нечему, а несвежий индекс опаснее отсутствующего.
            _crawlData = null;
        }
    }

    // Обходит одну сторону и говорит, можно ли доверять индексу: папку проверяем до
    // и после - пропавшая посреди обхода сеть читается как пустая ветка.
    private static async Task<bool> CrawlSide(string root, FsOps.CrawlEntry onEntry, List<string> skippedOut)
    {
        if (!IsDir(root)) return false;
        await FsOps.CrawlTree(root, "", onEntry, skippedOut);
        return IsDir(root);
    }

    // skipCached - в окне размеры уже есть (перезапуск по «Обновить», сортировке по дате):
    // кеш с диска не читаем и не шлём. Иначе каждый перезапуск разбирал 49 МБ кеша на 300
    // тысяч записей и заново вливал их в окно - паузы сборки мусора до 1,6 с (26.09.2026).
    public async Task<CrawlResult> StartCrawl(string? localPath, string? networkPath, bool noLimit, bool skipCached, ICrawlSink sink)
    {
        int token;
        lock (_gate) token = ++_crawlToken;
        bool Current() { lock (_gate) return token == _crawlToken; }

        // Сразу отдаём кешированные размеры с прошлого раза, кусками.
        var cached = skipCached ? null : await SizeCache.Load(localPath, networkPath);
        if (cached != null && Current())
        {
            for (var i = 0; i < cached.Count; i += 5000)
            {
                if (!Current()) break;
                sink.Cached(cached.GetRange(i, Math.Min(5000, cached.Count - i)));
            }
        }
        // Окно уже переложило записи к себе; локальная ссылка держала бы весь кеш
        // (~120 МБ на 300 тысяч записей) до конца обхода.
        cached = null;

        var index = new Dictionary<string, SizeRow>(StringComparer.Ordinal);
        var data = new CrawlData { LocalPath = localPath, NetworkPath = networkPath };

        var scanned = 0;
        var batch = new List<SizeEntry>();
        var lastSave = Stopwatch.StartNew();
        var saving = 0;
        var put = new object();
        var active = new ActiveCrawl(index, put, localPath, networkPath);
        lock (_gate)
        {
            _activeCrawl = active;
            _crawlData = data;
        }

        void Flush()
        {
            List<SizeEntry> send;
            int n;
            lock (put)
            {
                if (batch.Count == 0) return;
                send = batch;
                batch = new List<SizeEntry>();
                n = scanned;
            }
            sink.Progress(n, send);
        }

        List<SizeEntry> SnapshotIndex()
        {
            lock (put) return index.Values.Select(r => r.Snapshot()).ToList();
        }

        // Сохраняет кеш, только если этот обход ещё текущий: погашенный дописывал бы
        // свой черновик поверх полного кеша пришедшего ему на смену.
        Task SaveIfCurrent() => Current() ? SizeCache.Save(localPath, networkPath, SnapshotIndex()) : Task.CompletedTask;

        void MaybeSave()
        {
            int size;
            lock (put) size = index.Count;
            var interval = Math.Min(40000, Math.Max(5000, size / 8));
            if (lastSave.ElapsedMilliseconds < interval || Interlocked.CompareExchange(ref saving, 1, 0) != 0) return;
            lastSave.Restart();
            _ = SaveIfCurrent().ContinueWith(_ => Volatile.Write(ref saving, 0));
        }

        // Ключ - путь без учёта регистра: стороны пишут одну папку по-разному, а строка
        // в дереве одна. Первое написание сохраняем - по нему окно находит строку.
        void Put(string rel, bool localSide, long size, int cnt)
        {
            if (!Current()) throw new CrawlAborted();
            bool flush;
            lock (put)
            {
                if (!noLimit && scanned >= MaxCrawl) throw new CrawlTooBig();
                var key = Paths.CiKey(rel);
                if (!index.TryGetValue(key, out var e)) index[key] = e = new SizeRow(rel);
                if (localSide)
                {
                    e.SizeLocal = size;
                    e.CntLocal = cnt;
                }
                else
                {
                    e.SizeNetwork = size;
                    e.CntNetwork = cnt;
                }
                scanned++;
                batch.Add(e.Snapshot());
                flush = batch.Count >= 300;
            }
            if (flush) Flush();
            MaybeSave();
        }

        var trusted = true;
        try
        {
            if (!string.IsNullOrEmpty(localPath))
            {
                var ok = await CrawlSide(localPath, (rel, isFolder, size, cnt, mtime) =>
                {
                    Put(rel, true, size, cnt);
                    lock (data)
                    {
                        if (isFolder) data.LocalDirs.Add(rel);
                        else data.Local[rel] = (size, mtime ?? 0);
                    }
                }, data.LocalSkipped);
                if (!ok) trusted = false;
            }
            if (!string.IsNullOrEmpty(networkPath))
            {
                var ok = await CrawlSide(networkPath, (rel, isFolder, size, cnt, mtime) =>
                {
                    Put(rel, false, size, cnt);
                    lock (data)
                    {
                        if (isFolder) data.NetworkDirs.Add(rel);
                        else data.Network[rel] = (size, mtime ?? 0);
                    }
                }, data.NetworkSkipped);
                if (!ok) trusted = false;
            }
            Flush();
            if (!Current()) return new CrawlResult(false, Aborted: true);
            await SaveIfCurrent();
            var noAccess = data.LocalSkipped.Count + data.NetworkSkipped.Count;
            // Синхронизация за время обхода обнуляет индекс: он описывает уже не то дерево.
            lock (_gate)
            {
                if (_crawlData == data)
                {
                    data.Complete = trusted; // только полный обход годится вместо скана
                    data.At = Now();
                }
            }
            sink.Done(new CrawlDone(scanned, true, !trusted, noAccess));
            return new CrawlResult(true, scanned, !trusted, noAccess);
        }
        catch (Exception err)
        {
            // Частичный прогресс сохраняем, но только если обход ещё наш.
            await SaveIfCurrent();
            if (err is CrawlAborted) return new CrawlResult(false, Aborted: true);
            if (err is CrawlTooBig)
            {
                sink.Done(new CrawlDone(scanned, false, TooBig: true));
                return new CrawlResult(false, TooBig: true);
            }
            sink.Done(new CrawlDone(scanned, false, Error: err.Message));
            return new CrawlResult(false, Error: err.Message);
        }
        finally
        {
            // Ссылку снимаем всегда: после обрыва она держала бы черновик, и закрытие
            // окна сохранило бы его поверх полного кеша следующего обхода.
            lock (_gate) if (_activeCrawl == active) _activeCrawl = null;
        }
    }

    // При закрытии окна - сохранить прогресс обхода. Для очень больших деревьев
    // пропускаем: синхронная запись надолго задержала бы выход.
    public void BeforeQuit()
    {
        ActiveCrawl? a;
        lock (_gate) a = _activeCrawl;
        if (a == null) return;
        List<SizeEntry> rows;
        lock (a.Lock) rows = a.Index.Values.Select(r => r.Snapshot()).ToList();
        if (rows.Count > 0 && rows.Count <= 150000) SizeCache.SaveSync(a.LocalPath, a.NetworkPath, rows);
    }

    // Прошлый запуск мог оборваться: в служебной папке лежат оригиналы - вернуть их
    // на обеих сторонах до плана (оборвавшийся запуск мог идти в другую сторону).
    private async Task<int> RestoreBothStages(string srcRoot, string dstRoot)
    {
        async Task<int> One(string root)
        {
            try { return await FsOps.RestoreStage(root); } catch { return 0; }
        }
        var counts = await Task.WhenAll(One(srcRoot), One(dstRoot));
        var restored = counts[0] + counts[1];
        if (restored > 0) DropCaches(); // дерево изменилось - прежний индекс неверен
        return restored;
    }

    // ---- Предпросмотр ----

    private int _previewToken;

    public void CancelPreview() => Interlocked.Increment(ref _previewToken);

    public async Task<PreviewResult> Preview(SyncArgs args, IProgress<int>? progress = null)
    {
        var (srcRoot, dstRoot) = args.Direction == "toNetwork" ? (args.LocalPath, args.NetworkPath) : (args.NetworkPath, args.LocalPath);
        var token = Interlocked.Increment(ref _previewToken);
        var scanned = 0;
        var lastSent = Stopwatch.StartNew();
        void OnFile()
        {
            if (Volatile.Read(ref _previewToken) != token) throw new OperationCanceledException("aborted");
            var n = Interlocked.Increment(ref scanned);
            if (lastSent.ElapsedMilliseconds > 150)
            {
                lastSent.Restart();
                progress?.Report(n);
            }
        }

        try
        {
            AssertRootsReachable(srcRoot, dstRoot);
            await RestoreBothStages(srcRoot!, dstRoot!);
            var plan = await Plan.BuildRunPlan(srcRoot!, dstRoot!, args.Folders, args.Excludes, MakeScanner(OnFile, args.Folders));
            return new PreviewResult(
                Plan.CountByFolder(plan, args.Folders),
                SyncOps.Summarize(plan),
                // Закрытые правами папки работой не станут, но и промолчать о них нельзя.
                plan.Skipped.Take(20).ToList(),
                plan.Skipped.Count);
        }
        catch (OperationCanceledException)
        {
            return new PreviewResult(Aborted: true);
        }
        catch (Exception err)
        {
            return new PreviewResult(Error: err.Message);
        }
    }

    // ---- Синхронизация ----

    private volatile bool _syncStopped;
    private int _syncRunning;

    public void CancelSync() => _syncStopped = true;

    // Замок на время работы: два запуска разом делят служебную папку на приёмнике.
    // Интерфейс блокирует кнопку, но полагаться на интерфейс нельзя.
    public async Task<SyncResult> Sync(SyncArgs args, IProgress<SyncProgress>? progress = null)
    {
        if (Interlocked.CompareExchange(ref _syncRunning, 1, 0) != 0) return new SyncResult(Error: "синхронизация уже идёт");
        try
        {
            return await PerformSync(args, progress);
        }
        finally
        {
            Volatile.Write(ref _syncRunning, 0);
        }
    }

    // Удаление мимо Корзины (почему - см. main.js): рекурсивно, со снятием «только чтение».
    private static void RmForce(string abs)
    {
        try
        {
            FsOps.RmForce(abs);
        }
        catch (UnauthorizedAccessException)
        {
            if (Directory.Exists(abs))
                foreach (var f in Directory.EnumerateFileSystemEntries(abs, "*", SearchOption.AllDirectories))
                    try { File.SetAttributes(f, FileAttributes.Normal); } catch { /* попробуем как есть */ }
            else if (File.Exists(abs))
                File.SetAttributes(abs, FileAttributes.Normal);
            FsOps.RmForce(abs);
        }
    }

    private async Task<SyncResult> PerformSync(SyncArgs args, IProgress<SyncProgress>? progress)
    {
        var (srcRoot, dstRoot) = args.Direction == "toNetwork" ? (args.LocalPath, args.NetworkPath) : (args.NetworkPath, args.LocalPath);
        _syncStopped = false;

        // Первым делом - до разбора служебной папки, которая уже двигает файлы.
        try
        {
            AssertRootsReachable(srcRoot, dstRoot);
        }
        catch (Exception err)
        {
            return new SyncResult(Error: err.Message);
        }

        await RestoreBothStages(srcRoot!, dstRoot!);

        SyncPlan plan;
        try
        {
            plan = await Plan.BuildRunPlan(srcRoot!, dstRoot!, args.Folders, args.Excludes, MakeScanner(null, args.Folders));
        }
        catch (Exception err)
        {
            // Сорвался обычно обрыв связи - прочитанное под вопросом, кеши сбрасываем.
            DropCaches();
            return new SyncResult(Error: $"не удалось прочитать папки ({err.Message})");
        }
        var totals = SyncOps.Summarize(plan);

        // Прогресс не чаще ~10 раз в секунду; счётчики по действиям - точные, снимком.
        var doneBy = new Dictionary<string, int> { ["move"] = 0, ["copy"] = 0, ["overwrite"] = 0, ["trash"] = 0 };
        var lastSent = Stopwatch.StartNew();
        var first = true;

        ApplyResult res;
        try
        {
            res = await FsOps.ApplyPlan(srcRoot!, dstRoot!, plan, (abs, _) =>
            {
                RmForce(abs);
                return Task.CompletedTask;
            }, p =>
            {
                // ApplyPlan зовёт прогресс под своим замком - по одному.
                if (doneBy.ContainsKey(p.Action)) doneBy[p.Action]++;
                if (first || lastSent.ElapsedMilliseconds >= 100 || p.Done == p.Total)
                {
                    first = false;
                    lastSent.Restart();
                    progress?.Report(new SyncProgress(p.Done, p.Total, p.Action, p.Path, new Dictionary<string, int>(doneBy)));
                }
            }, () => _syncStopped);
        }
        catch (Exception err)
        {
            DropCaches();
            return new SyncResult(Error: err.Message, Started: true);
        }

        // Приёмник изменился - кеши устарели.
        DropCaches();

        if (res.Cancelled)
        {
            progress?.Report(new SyncProgress(res.Done, res.Total, "rollback", "", new Dictionary<string, int>(doneBy)));
            return new SyncResult(res.Done, res.Total, res.Unrecoverable, res.Failures.Count, Cancelled: true);
        }

        // ---- Запись в историю ----
        if (totals.Total > 0)
        {
            // Осечки помечены путём, по которому шла операция: у перемещения это To.
            var failSet = new HashSet<string>(res.Failures.Select(f => $"{f.Action} {f.Path}"), StringComparer.Ordinal);
            IEnumerable<HistoryFile> Collect(string action, IEnumerable<(string Key, string Label)> list)
                => list.Where(e => !failSet.Contains($"{action} {e.Key}")).Select(e => new HistoryFile(action, e.Label));

            // Конфликты типа тоже убирают узел с приёмника - в истории им место рядом с удалениями.
            var all = Collect("trash", plan.Conflicts.Select(r => (r, r)))
                .Concat(Collect("trash", plan.Trash.Select(e => (e.Path, e.Path))))
                .Concat(Collect("move", plan.Moves.Select(m => (m.Path, $"{m.From} → {m.To}"))))
                .Concat(Collect("overwrite", plan.Overwrite.Select(e => (e.Path, e.Path))))
                .Concat(Collect("copy", plan.Copy.Select(e => (e.Path, e.Path))))
                .ToList();
            var files = all.Take(HistoryStore.FileCap).ToList();

            await History.Append(new HistoryRun
            {
                Time = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
                Direction = args.Direction,
                LocalPath = args.LocalPath,
                NetworkPath = args.NetworkPath,
                Totals = new HistoryTotals { Move = totals.Move, Copy = totals.Copy, Overwrite = totals.Overwrite, Trash = totals.Trash, Dirs = totals.Dirs },
                Failures = res.Failures.Count,
                Files = files,
                FilesTruncated = all.Count - files.Count,
            });
        }

        return new SyncResult(res.Done, res.Total, res.Unrecoverable, res.Failures.Count,
            res.Failures.Take(5).Select(f => $"{f.Path} ({f.Code})").ToList(), plan.Skipped.Count);
    }
}
