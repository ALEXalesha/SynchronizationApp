using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace SyncGlass.Core.Main;

// Общие файлы двух версий в %APPDATA%\SyncGlass. Формат - как пишет Electron:
// имена полей camelCase, русские буквы как есть (JSON.stringify их не экранирует).
public static class Store
{
    public static readonly JsonSerializerOptions Compact = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // settings.json JS пишет с отступом в два пробела.
    public static readonly JsonSerializerOptions Indented = new(Compact) { WriteIndented = true };

    // Кеш размеров хранит null как значение («эта сторона ещё не посчитана»),
    // поэтому null тут не выбрасывается.
    public static readonly JsonSerializerOptions WithNulls = new(Compact) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };

    private static int _seq;

    // Атомарная запись: временный файл, затем переименование поверх. Обычная запись
    // сначала обрезает файл, и вылет между обрезанием и записью оставлял пустышку.
    // Имя временного - как в JS (<файл>.<N>.tmp): осиротевшие разбирает CleanupTempFiles.
    public static async Task WriteAtomic(string path, string text)
    {
        var tmp = $"{path}.{Interlocked.Increment(ref _seq)}.tmp";
        await File.WriteAllTextAsync(tmp, text);
        FsOps.Rename(tmp, path);
    }

    public static void WriteAtomicSync(string path, string text)
    {
        var tmp = $"{path}.{Interlocked.Increment(ref _seq)}.tmp";
        File.WriteAllText(tmp, text);
        FsOps.Rename(tmp, path);
    }
}

// Настройки: пути, направление, сортировка, режим размеров. Незнакомые поля
// (их может записать другая версия) сохраняются как есть.
public sealed class AppSettings
{
    public string? LocalPath { get; set; }
    public string? NetworkPath { get; set; }
    public string? Direction { get; set; }   // toNetwork | toLocal
    public string? Sort { get; set; }        // name | date
    public string? SizeMode { get; set; }    // off | capped | full

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Other { get; set; }
}

public sealed record HistoryFile(string Action, string Path);

public sealed class HistoryTotals
{
    public int Move { get; set; }
    public int Copy { get; set; }
    public int Overwrite { get; set; }
    public int Trash { get; set; }
    public int Dirs { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Other { get; set; }
}

// Запись истории - как её пишет performSync в main.js.
public sealed class HistoryRun
{
    public string? Time { get; set; }
    public string? Direction { get; set; }
    public string? LocalPath { get; set; }
    public string? NetworkPath { get; set; }
    public HistoryTotals? Totals { get; set; }
    public int Failures { get; set; }
    public List<HistoryFile>? Files { get; set; }
    public int? FilesTruncated { get; set; }
    public bool? DetailsDropped { get; set; }
    public int? FileCount { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Other { get; set; }
}

// Строка кеша размеров: сумма и число файлов узла на каждой стороне (null - не посчитано).
public sealed record SizeEntry(string RelPath, long? SizeLocal, int? CntLocal, long? SizeNetwork, int? CntNetwork);

public sealed class SettingsStore(string userData)
{
    public string Path { get; } = System.IO.Path.Join(userData, "settings.json");

    public async Task<AppSettings> Load()
    {
        try
        {
            return JsonSerializer.Deserialize<AppSettings>(await File.ReadAllTextAsync(Path), Store.Compact) ?? new AppSettings();
        }
        catch
        {
            return new AppSettings();
        }
    }

    // Настройки не критичны - сбой записи молча игнорируем, но атомарно, как соседи:
    // пустой settings.json после обрыва забывал обе выбранные папки.
    public async Task Save(AppSettings settings)
    {
        try
        {
            await Store.WriteAtomic(Path, JsonSerializer.Serialize(settings, Store.Indented));
        }
        catch
        {
            // настройки не критичны
        }
    }
}

public sealed class HistoryStore(string userData)
{
    public const int MaxRuns = 200;        // сколько запусков храним
    public const int FileCap = 5000;       // максимум файлов в одной записи (удаления в приоритете)
    // У скольких последних запусков храним поимённый список: пределы перемножались
    // (200 × 5000 - 87 МБ и миллион строк в окне истории).
    public const int DetailRuns = 20;

    public string Path { get; } = System.IO.Path.Join(userData, "history.json");

    // Срезает поимённые списки у старых записей - и на чтении, и на записи.
    public static List<HistoryRun> TrimDetails(List<HistoryRun> list)
    {
        for (var i = DetailRuns; i < list.Count; i++)
        {
            var run = list[i];
            if (run.Files == null) continue;
            run.FileCount = run.Files.Count;
            run.DetailsDropped = true;
            run.Files = null;
        }
        return list;
    }

    // Битые записи отсеиваем у самого чтения: одна запись null в файле - и окно
    // истории обрывалось на полуслове.
    public async Task<List<HistoryRun>> Load()
    {
        try
        {
            var node = JsonNode.Parse(await File.ReadAllTextAsync(Path));
            if (node is not JsonArray arr) return new List<HistoryRun>();
            var outList = new List<HistoryRun>();
            foreach (var item in arr)
            {
                if (item is not JsonObject obj) continue;
                try
                {
                    var run = obj.Deserialize<HistoryRun>(Store.Compact);
                    if (run != null) outList.Add(run);
                }
                catch
                {
                    // запись не того вида - отсеиваем, как мусор
                }
            }
            return outList;
        }
        catch
        {
            return new List<HistoryRun>();
        }
    }

    public async Task Append(HistoryRun record)
    {
        try
        {
            var list = await Load();
            list.Insert(0, record); // новые сверху
            if (list.Count > MaxRuns) list.RemoveRange(MaxRuns, list.Count - MaxRuns);
            await Store.WriteAtomic(Path, JsonSerializer.Serialize(TrimDetails(list), Store.Compact));
        }
        catch
        {
            // история не критична
        }
    }

    public Task Clear()
    {
        try { File.Delete(Path); } catch { /* ignore */ }
        return Task.CompletedTask;
    }
}

public sealed class SizeCacheStore(string userData)
{
    // Сколько кешей держим: кеш заводится на каждую пару путей и весит десятки МБ.
    public const int Keep = 6;

    private readonly string _dir = userData;

    // Имя - md5 от «локальный \0 сетевой» в UTF-8, как у JS: иначе две версии
    // не находили бы кеш друг друга и обходили бы дерево заново.
    public string FileFor(string? localPath, string? networkPath)
    {
        var hash = System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes($"{localPath ?? ""}\0{networkPath ?? ""}"));
        return System.IO.Path.Join(_dir, $"sizecache-{Convert.ToHexString(hash).ToLowerInvariant()}.json");
    }

    // Достоверность проверяем у самого чтения: строка вместо массива, число, запись
    // без пути - всё это уезжало бы в интерфейс как готовые размеры.
    public async Task<List<SizeEntry>?> Load(string? localPath, string? networkPath)
    {
        try
        {
            var node = JsonNode.Parse(await File.ReadAllTextAsync(FileFor(localPath, networkPath))) as JsonObject;
            if (node == null) return null;
            if ((string?)node["localPath"] != localPath || (string?)node["networkPath"] != networkPath) return null;
            if (node["entries"] is not JsonArray arr) return null;
            var outList = new List<SizeEntry>(arr.Count);
            foreach (var item in arr)
            {
                if (item is not JsonObject e || e["relPath"] is not JsonValue rp || !rp.TryGetValue<string>(out var rel)) continue;
                outList.Add(new SizeEntry(rel, Num<long>(e["sizeLocal"]), Num<int>(e["cntLocal"]), Num<long>(e["sizeNetwork"]), Num<int>(e["cntNetwork"])));
            }
            return outList;
        }
        catch
        {
            return null; // нет кеша - не страшно
        }
    }

    private static T? Num<T>(JsonNode? n) where T : struct
        => n is JsonValue v && v.TryGetValue<T>(out var x) ? x : null;

    private static string Serialize(string? localPath, string? networkPath, IEnumerable<SizeEntry> entries)
        => JsonSerializer.Serialize(new { localPath, networkPath, entries }, Store.WithNulls);

    public async Task Save(string? localPath, string? networkPath, IEnumerable<SizeEntry> entries)
    {
        try { await Store.WriteAtomic(FileFor(localPath, networkPath), Serialize(localPath, networkPath, entries)); }
        catch { /* кеш не критичен */ }
    }

    // При закрытии окна - синхронно, но тоже через временный файл: обрезок вместо
    // целого кеша на сотни тысяч узлов не разбирался, и следующий запуск ждал обход.
    public void SaveSync(string? localPath, string? networkPath, IEnumerable<SizeEntry> entries)
    {
        try { Store.WriteAtomicSync(FileFor(localPath, networkPath), Serialize(localPath, networkPath, entries)); }
        catch { /* кеш не критичен */ }
    }

    // Осиротевшие .tmp от прерванных записей и лишние кеши размеров. На старте
    // активных записей ещё нет, поэтому любой .tmp - мусор.
    public void CleanupTempFiles()
    {
        try
        {
            var files = Directory.GetFiles(_dir);
            foreach (var f in files.Where(f => f.EndsWith(".tmp", StringComparison.Ordinal)))
                try { File.Delete(f); } catch { /* не критично */ }
            var caches = files.Where(f => System.IO.Path.GetFileName(f).StartsWith("sizecache-", StringComparison.Ordinal)
                                          && f.EndsWith(".json", StringComparison.Ordinal)).ToList();
            if (caches.Count <= Keep) return;
            foreach (var old in caches.OrderByDescending(File.GetLastWriteTimeUtc).Skip(Keep))
                try { File.Delete(old); } catch { /* не критично */ }
        }
        catch
        {
            // не критично
        }
    }
}
