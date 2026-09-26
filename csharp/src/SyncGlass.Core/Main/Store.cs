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

    // То же, но файл пишется потоком: большой файл (кеш размеров - десятки МБ) не
    // собирается целиком в памяти строкой.
    public static void WriteAtomicSync(string path, Action<Stream> write)
    {
        var tmp = $"{path}.{Interlocked.Increment(ref _seq)}.tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
            write(fs);
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
    //
    // Файл читается и пишется ПОТОКОМ (закон CacheMemoryTests). Раньше кеш на 300 тысяч
    // записей (49 МБ) читался в строку и разбирался в дерево JsonNode - куча вырастала до
    // 623 МБ ради списка в 120 МБ, а окно C#-версии держало 1,3 ГБ.
    //
    // Ядро синхронное, асинхронная обёртка лишь уносит его в пул: так закон может мерить
    // выделенное своим потоком - счётчик всего процесса ловил и фон соседних тестов.
    public Task<List<SizeEntry>?> Load(string? localPath, string? networkPath)
        => Task.Run(() => LoadSync(localPath, networkPath));

    public List<SizeEntry>? LoadSync(string? localPath, string? networkPath)
    {
        try
        {
            using var fs = new FileStream(FileFor(localPath, networkPath), FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
            var file = JsonSerializer.Deserialize<CacheFile>(fs, ReadOptions);
            if (file == null) return null;
            if (Str(file.LocalPath) != localPath || Str(file.NetworkPath) != networkPath) return null;
            if (file.Entries == null) return null;
            file.Entries.RemoveAll(e => e == null);
            return file.Entries!;
        }
        catch
        {
            return null; // нет кеша - не страшно
        }
    }

    // Путь в шапке: нет поля или null - null; строка - строка; другое - кеш негоден.
    private static string? Str(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Undefined or JsonValueKind.Null => null,
        JsonValueKind.String => e.GetString(),
        _ => throw new InvalidDataException("путь в кеше не строка"),
    };

    private sealed class CacheFile
    {
        [JsonPropertyName("localPath")] public JsonElement LocalPath { get; set; }
        [JsonPropertyName("networkPath")] public JsonElement NetworkPath { get; set; }
        [JsonPropertyName("entries")] public List<SizeEntry?>? Entries { get; set; }
    }

    private static readonly JsonSerializerOptions ReadOptions = new() { Converters = { new EntryReader() } };

    // Одна запись кеша. Достоверность - как раньше: не объект или путь не строка -
    // запись пропускается; поле не число (или не влезает) - «не посчитано» (null).
    private sealed class EntryReader : JsonConverter<SizeEntry?>
    {
        public override bool HandleNull => true;

        public override SizeEntry? Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o)
        {
            if (r.TokenType != JsonTokenType.StartObject)
            {
                r.TrySkip(); // значение уже в буфере целиком; Skip() на потоке бросает
                return null;
            }
            string? rel = null;
            long? sizeLocal = null, sizeNetwork = null;
            int? cntLocal = null, cntNetwork = null;
            while (r.Read() && r.TokenType == JsonTokenType.PropertyName)
            {
                if (r.ValueTextEquals("relPath"u8)) { r.Read(); rel = r.TokenType == JsonTokenType.String ? r.GetString() : null; }
                else if (r.ValueTextEquals("sizeLocal"u8)) { r.Read(); sizeLocal = r.TokenType == JsonTokenType.Number && r.TryGetInt64(out var v) ? v : null; }
                else if (r.ValueTextEquals("cntLocal"u8)) { r.Read(); cntLocal = r.TokenType == JsonTokenType.Number && r.TryGetInt32(out var v) ? v : null; }
                else if (r.ValueTextEquals("sizeNetwork"u8)) { r.Read(); sizeNetwork = r.TokenType == JsonTokenType.Number && r.TryGetInt64(out var v) ? v : null; }
                else if (r.ValueTextEquals("cntNetwork"u8)) { r.Read(); cntNetwork = r.TokenType == JsonTokenType.Number && r.TryGetInt32(out var v) ? v : null; }
                else r.Read();
                // Вложенный объект или массив на месте значения; у простого - ничего.
                // TrySkip, не Skip: значение уже в буфере, а Skip() на потоке бросает всегда.
                r.TrySkip();
            }
            return rel == null ? null : new SizeEntry(rel, sizeLocal, cntLocal, sizeNetwork, cntNetwork);
        }

        public override void Write(Utf8JsonWriter w, SizeEntry? value, JsonSerializerOptions o) => throw new NotSupportedException();
    }

    // Запись - тем же порядком полей и тем же экранированием, что JSON.stringify у Electron.
    private static void WriteCache(Stream s, string? localPath, string? networkPath, IEnumerable<SizeEntry> entries)
    {
        using var w = new Utf8JsonWriter(s, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        static void Num(Utf8JsonWriter w, string name, long? v)
        {
            if (v is { } x) w.WriteNumber(name, x);
            else w.WriteNull(name);
        }
        w.WriteStartObject();
        if (localPath != null) w.WriteString("localPath", localPath); else w.WriteNull("localPath");
        if (networkPath != null) w.WriteString("networkPath", networkPath); else w.WriteNull("networkPath");
        w.WriteStartArray("entries");
        foreach (var e in entries)
        {
            w.WriteStartObject();
            w.WriteString("relPath", e.RelPath);
            Num(w, "sizeLocal", e.SizeLocal);
            Num(w, "cntLocal", e.CntLocal);
            Num(w, "sizeNetwork", e.SizeNetwork);
            Num(w, "cntNetwork", e.CntNetwork);
            w.WriteEndObject();
            if (w.BytesPending > 1 << 15) w.Flush(); // в файл кусками, а не всё разом в конце
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    public Task Save(string? localPath, string? networkPath, IEnumerable<SizeEntry> entries)
        => Task.Run(() => SaveSync(localPath, networkPath, entries));

    // При закрытии окна - синхронно, но тоже через временный файл: обрезок вместо
    // целого кеша на сотни тысяч узлов не разбирался, и следующий запуск ждал обход.
    public void SaveSync(string? localPath, string? networkPath, IEnumerable<SizeEntry> entries)
    {
        try { Store.WriteAtomicSync(FileFor(localPath, networkPath), s => WriteCache(s, localPath, networkPath, entries)); }
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
