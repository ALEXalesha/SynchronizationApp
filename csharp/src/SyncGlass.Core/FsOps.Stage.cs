namespace SyncGlass.Core;

public static partial class FsOps
{
    // Сносит пустые папки снизу вверх. True - dir остался пуст. Пустой каркас внутри
    // служебной папки - наших рук дело; всё остальное (файл, ссылка, непустая ветка)
    // значит, что узел вернуть не удалось.
    internal static bool PruneEmptyDirs(string dir)
    {
        List<Dirent> dirents;
        try
        {
            dirents = ReadDir(dir);
        }
        catch (Exception e) when (IsGone(e))
        {
            return true; // папки нет - считаем пустой
        }
        catch
        {
            return false; // заглянуть не вышло - тем более не трогаем
        }
        var empty = true;
        foreach (var d in dirents)
        {
            var sub = Path.Join(dir, d.Name);
            if (d.IsDir && !d.IsSymlink && PruneEmptyDirs(sub))
            {
                try
                {
                    Directory.Delete(sub, false);
                    continue;
                }
                catch
                {
                    // убрать не вышло - папка остаётся, и вместе с ней вся ветка
                }
            }
            empty = false;
        }
        return empty;
    }

    // Убирает служебную папку, только если внутри ничего не осталось. Иначе содержимое
    // разберёт RestoreStage на следующем запуске: стереть вслепую - уничтожить
    // единственную копию файла молча. Считаем обходом каталогов, а не ScanFiles:
    // тот не видит ни пустых папок, ни узлов с именем служебной папки.
    internal static bool RemoveStageIfEmpty(string stageRoot)
    {
        if (!PruneEmptyDirs(stageRoot)) return false;
        try { RmForce(stageRoot); } catch { /* не вышло - не страшно, пустая */ }
        return true;
    }

    // Возвращает узлы служебной папки на свои места: сверху вниз и целиком. Место
    // свободно - один rename возвращает всё поддерево (быстрее по сети и сохраняет пустые
    // папки). Место занято папкой - разбираем её содержимое по одному, вглубь.
    private static async Task RestoreTree(string stageDir, string dstDir, int[] restored)
    {
        List<Dirent> dirents;
        try
        {
            dirents = ReadDir(stageDir);
        }
        catch
        {
            return; // заглянуть не вышло - оставляем до следующего запуска
        }
        try
        {
            Mkdir(dstDir);
        }
        catch
        {
            return; // некуда возвращать (путь занят файлом) - пусть ждёт
        }

        await RunPool(dirents, ApplyConcurrency, async d =>
        {
            var from = Path.Join(stageDir, d.Name);
            var to = Path.Join(dstDir, d.Name);
            try
            {
                Rename(from, to);
                Interlocked.Increment(ref restored[0]);
                return;
            }
            catch
            {
                // место занято или узел держат открытым
            }
            if (!d.IsDir || d.IsSymlink) return;
            // На месте уже стоит папка: сливаем содержимое, а опустевший каркас убираем.
            await RestoreTree(from, to, restored);
            try { Directory.Delete(from, false); } catch { /* осталось невозвращённое */ }
        });
    }

    // Возвращает содержимое служебной папки приёмника на свои места: прошлый запуск мог
    // оборваться (вылет, питание), и прерванный запуск считаем несостоявшимся.
    public static async Task<int> RestoreStage(string dstRoot)
    {
        var stageRoot = Path.Join(dstRoot, StageDir);
        var restored = new int[1];
        await RestoreTree(stageRoot, dstRoot, restored);
        RemoveStageIfEmpty(stageRoot);
        return restored[0];
    }
}
