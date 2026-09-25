using System.Collections.Concurrent;

namespace SyncGlass.Core;

public sealed record Failure(string Action, string Path, string Code);

public sealed record Progress(int Done, int Total, string Action, string Path);

public sealed record ApplyResult(int Done, int Total, List<Failure> Failures, bool Cancelled, int Trashed, int Unrecoverable);

// Удаление: абсолютный путь и вес - сколько файлов покрывает вызов (служебная папка
// уезжает одним действием на всё содержимое).
public delegate Task TrashFn(string absPath, int weight);

public static partial class FsOps
{
    // Подмена наблюдателя mkdir для тестов, как подмена fsp.mkdir в JS-тесте про
    // mkdir на каждый файл. AsyncLocal - чтобы не доставалась параллельным тестам.
    internal static readonly AsyncLocal<Action<string>?> MkdirObserver = new();

    internal static void Mkdir(string dir)
    {
        MkdirObserver.Value?.Invoke(dir);
        Directory.CreateDirectory(dir);
    }

    public static Task EnsureDir(string dir)
    {
        Mkdir(dir);
        return Task.CompletedTask;
    }

    // Удалить узел целиком (как fsp.rm с recursive и force): нет узла - не ошибка.
    public static void RmForce(string abs)
    {
        if (Directory.Exists(abs) && !File.GetAttributes(abs).HasFlag(FileAttributes.ReparsePoint)) Directory.Delete(abs, true);
        else if (File.Exists(abs) || Directory.Exists(abs))
        {
            if (Directory.Exists(abs)) Directory.Delete(abs); // ссылка на папку - убрать саму ссылку
            else File.Delete(abs);
        }
    }

    // Сколько файлов лежит в узле. Файл - один; папка - сумма по содержимому.
    // Прочитать не вышло - считаем за один: занизить отчёт о безвозвратном удалении
    // хуже, чем завысить.
    internal static int CountFiles(string abs)
    {
        List<Dirent> dirents;
        try
        {
            dirents = ReadDir(abs);
        }
        catch
        {
            return 1;
        }
        var n = 0;
        foreach (var d in dirents)
        {
            if (d.IsSymlink) continue;
            n += d.IsDir ? CountFiles(Path.Join(abs, d.Name)) : 1;
        }
        return n;
    }

    // True - скопировал, false - источник исчез с момента сканирования (устаревшие данные).
    // ensure - чем создавать папку назначения: синхронизация передаёт свой кеш, иначе
    // каждый файл тянул бы отдельный mkdir по сети.
    public static async Task<bool> CopyFile(string srcRoot, string dstRoot, string relPath, Func<string, Task>? ensure = null)
    {
        var src = Path.Join(srcRoot, relPath);
        var dst = Path.Join(dstRoot, relPath);
        await (ensure ?? EnsureDir)(Path.GetDirectoryName(dst)!);
        try
        {
            File.Copy(src, dst, overwrite: true);
        }
        catch (Exception e) when (IsGone(e) && !File.Exists(src))
        {
            return false; // источник исчез с момента сканирования
        }
        catch (UnauthorizedAccessException)
        {
            // Приёмник, вероятно, только для чтения - снимаем атрибут и пробуем снова.
            try { File.SetAttributes(dst, FileAttributes.Normal); } catch { /* не вышло - повтор скажет сам */ }
            File.Copy(src, dst, overwrite: true);
        }

        // Перенос даты не критичен: сетевые шары часто запрещают его. Не вышло - пропускаем.
        try
        {
            var fi = new FileInfo(src);
            if (fi.Exists)
            {
                File.SetLastWriteTimeUtc(dst, fi.LastWriteTimeUtc);
                File.SetLastAccessTimeUtc(dst, fi.LastAccessTimeUtc);
            }
        }
        catch
        {
            // дату перенести не удалось - не критично
        }
        return true;
    }

    private sealed class Journal
    {
        public readonly List<string> Conflict = new(), Mkdir = new(), Copy = new(), Overwrite = new(), Stage = new(), Rmdir = new();
        public readonly List<Move> Move = new();
    }

    // Выполняет план. Каждое действие пишется в журнал, поэтому остановку можно
    // откатить. Оригиналы (перезаписываемые и удаляемые) не уничтожаются сразу,
    // а переименовываются в служебную папку внутри приёмника: переименование
    // мгновенно даже по сети, а откат - обратное переименование. Мусор выбрасывается
    // одним действием в самом конце. Ошибка отдельного файла не обрывает работу:
    // копится в Failures. Подробные «почему» - в комментариях src/fsops.js.
    public static async Task<ApplyResult> ApplyPlan(string srcRoot, string dstRoot, SyncPlan plan, TrashFn trashFn,
        Action<Progress>? onProgress = null, Func<bool>? shouldStop = null)
    {
        shouldStop ??= () => false;
        var moves = plan.Moves;
        var dirsCreate = plan.Dirs.Create;
        var dirsRemove = plan.Dirs.Remove;
        var conflicts = plan.Conflicts;
        var stageRoot = Path.Join(dstRoot, StageDir);

        var total = conflicts.Count + dirsCreate.Count + moves.Count + plan.Copy.Count + plan.Overwrite.Count
                    + plan.Trash.Count + dirsRemove.Count;

        var done = 0;
        var stopped = false;
        var gate = new object();
        var failures = new List<Failure>();
        // Конфликты живут отдельно от stage: откат разворачивает журнал в обратном порядке
        // фаз, а конфликты - первая фаза, значит возвращать их надо самыми последними.
        var journal = new Journal();

        void Report(string action, string relPath)
        {
            lock (gate)
            {
                done += 1;
                onProgress?.Invoke(new Progress(done, total, action, relPath));
            }
        }
        void Fail(string action, string relPath, Exception err)
        {
            lock (gate) failures.Add(new Failure(action, relPath, ErrCode(err)));
        }
        void FailCode(string action, string relPath, string code)
        {
            lock (gate) failures.Add(new Failure(action, relPath, code));
        }
        void Log<T>(List<T> list, T item)
        {
            lock (gate) list.Add(item);
        }

        // mkdir по каждому файлу тормозит по сети, поэтому помним созданное - именно
        // обещание, а не отметку о готовности: иначе вся пачка параллельных копий
        // проскакивала проверку. Неудачу не запоминаем: следующий вызов попробует заново.
        var madeDirs = new ConcurrentDictionary<string, Lazy<Task>>(StringComparer.Ordinal);
        Task EnsureOnce(string dir)
        {
            var lazy = madeDirs.GetOrAdd(dir, d => new Lazy<Task>(() => Task.Run(() => Mkdir(d))));
            var t = lazy.Value;
            t.ContinueWith(_ => madeDirs.TryRemove(new KeyValuePair<string, Lazy<Task>>(dir, lazy)),
                           TaskContinuationOptions.OnlyOnFaulted);
            return t;
        }

        async Task Stash(string relPath)
        {
            var parked = Path.Join(stageRoot, relPath);
            await EnsureOnce(Path.GetDirectoryName(parked)!);
            Rename(Path.Join(dstRoot, relPath), parked);
        }

        void Unstash(string relPath)
        {
            var back = Path.Join(dstRoot, relPath);
            Mkdir(Path.GetDirectoryName(back)!);
            Rename(Path.Join(stageRoot, relPath), back);
        }

        // Как только запрошена остановка, новые элементы не берём.
        async Task Phase<T>(IReadOnlyList<T> items, Func<T, Task> worker)
        {
            if (Volatile.Read(ref stopped) || items.Count == 0) return;
            await RunPool(items, ApplyConcurrency, async item =>
            {
                if (Volatile.Read(ref stopped)) return;
                if (shouldStop())
                {
                    Volatile.Write(ref stopped, true);
                    return;
                }
                await worker(item);
            });
        }

        // Последовательный вариант: для папок порядок важен.
        async Task Steps<T>(IReadOnlyList<T> items, Func<T, Task> worker)
        {
            if (Volatile.Read(ref stopped)) return;
            foreach (var item in items)
            {
                if (shouldStop())
                {
                    Volatile.Write(ref stopped, true);
                    return;
                }
                await worker(item);
            }
        }

        async Task DoMove(Move mv)
        {
            var to = Path.Join(dstRoot, mv.To);
            try
            {
                await EnsureOnce(Path.GetDirectoryName(to)!);
                Rename(Path.Join(dstRoot, mv.From), to);
                Log(journal.Move, mv);
            }
            catch
            {
                // Переименовать не вышло (файл занят, разные тома) - копируем по новому
                // пути, оригинал убираем в служебную папку.
                try
                {
                    if (await CopyFile(srcRoot, dstRoot, mv.To, EnsureOnce))
                    {
                        Log(journal.Copy, mv.To);
                        await Stash(mv.From);
                        Log(journal.Stage, mv.From);
                    }
                    else
                    {
                        // Источник исчез после сканирования. Оригинал не трогаем: убери мы его,
                        // файл пропал бы с обеих сторон.
                        FailCode("move", mv.To, "ENOENT");
                    }
                }
                catch (Exception err)
                {
                    Fail("move", mv.To, err);
                }
            }
            Report("move", mv.To);
        }

        async Task DoCopy(FileEntry entry)
        {
            try
            {
                // false - источник исчез: копировать нечего, и в журнал писать нечего.
                if (await CopyFile(srcRoot, dstRoot, entry.Path, EnsureOnce)) Log(journal.Copy, entry.Path);
                else FailCode("copy", entry.Path, "ENOENT");
            }
            catch (Exception err)
            {
                Fail("copy", entry.Path, err);
            }
            Report("copy", entry.Path);
        }

        // Сколько файлов обработано в обход журнала: их откат не вернёт.
        var unrecoverable = 0;

        // Сколько файлов покрывает один отложенный узел: обычно один, и только конфликт
        // типа уезжает целой веткой.
        var parkedWeight = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);
        int WeightOf(string rel) => parkedWeight.TryGetValue(rel, out var w) ? w : 1;

        // Оригиналы, застрявшие в служебной папке: отложены, заменить не вышло, вернуть -
        // тоже. В журнал не попадают, а другой копии у них нет - помним, чтобы в конце
        // выбросить только своё.
        var orphans = new List<string>();
        void PutBack(string relPath)
        {
            try
            {
                Unstash(relPath);
            }
            catch
            {
                Log(orphans, relPath);
            }
        }

        async Task DoOverwrite(FileEntry entry)
        {
            var parked = true;
            try
            {
                await Stash(entry.Path);
            }
            catch
            {
                // Не удалось отложить оригинал - пишем поверх; откатить такой файл будет нечем.
                parked = false;
            }
            try
            {
                if (await CopyFile(srcRoot, dstRoot, entry.Path, EnsureOnce))
                {
                    if (parked) Log(journal.Overwrite, entry.Path);
                    // Оригинал затёрт копией, а откат разворачивает только служебную папку.
                    else Interlocked.Increment(ref unrecoverable);
                }
                else
                {
                    // Источник исчез: заменять нечем - возвращаем отложенный оригинал.
                    if (parked) PutBack(entry.Path);
                    FailCode("overwrite", entry.Path, "ENOENT");
                }
            }
            catch (Exception err)
            {
                // Оригинал уже убран, а новый не лёг - возвращаем старый.
                if (parked) PutBack(entry.Path);
                Fail("overwrite", entry.Path, err);
            }
            Report("overwrite", entry.Path);
        }

        async Task DoStage(FileEntry entry)
        {
            try
            {
                await Stash(entry.Path);
                Log(journal.Stage, entry.Path);
            }
            catch
            {
                // Не удалось отложить - удаляем сразу.
                try
                {
                    await trashFn(Path.Join(dstRoot, entry.Path), 1);
                    Interlocked.Increment(ref unrecoverable);
                }
                catch (Exception err)
                {
                    Fail("trash", entry.Path, err);
                }
            }
            Report("trash", entry.Path);
        }

        // Узел разного типа на сторонах (папка против файла) убираем первым делом - иначе
        // mkdir упрётся в файл, а копия файла ляжет поверх папки. Уезжает он туда же,
        // куда остальные оригиналы, и вес его - всё содержимое.
        async Task DoConflict(string rel)
        {
            var вес = CountFiles(Path.Join(dstRoot, rel));
            parkedWeight[rel] = вес;
            try
            {
                await Stash(rel);
                Log(journal.Conflict, rel);
            }
            catch
            {
                // Отложить не вышло - убираем сразу, вернуть будет нечем.
                try
                {
                    await trashFn(Path.Join(dstRoot, rel), вес);
                    Interlocked.Increment(ref unrecoverable);
                }
                catch (Exception err)
                {
                    Fail("trash", rel, err);
                }
            }
            Report("trash", rel);
        }

        await Steps(conflicts, DoConflict);

        // Папки создаём от мелких к глубоким, поэтому по порядку и без пула.
        await Steps(dirsCreate, rel =>
        {
            try
            {
                Mkdir(Path.Join(dstRoot, rel));
                Log(journal.Mkdir, rel);
            }
            catch (Exception err)
            {
                Fail("mkdir", rel, err);
            }
            Report("mkdir", rel);
            return Task.CompletedTask;
        });

        await Phase(moves, DoMove);
        await Phase(plan.Copy, DoCopy);
        await Phase(plan.Overwrite, DoOverwrite);
        await Phase(plan.Trash, DoStage);

        // Лишние папки - от глубоких к мелким. Именно rmdir, а не рекурсивное удаление:
        // он падает на непустой папке, и это защита исключённого из синхронизации.
        await Steps(dirsRemove, rel =>
        {
            try
            {
                Directory.Delete(Path.Join(dstRoot, rel), false);
                Log(journal.Rmdir, rel);
            }
            catch
            {
                // не пустая или уже нет - так и задумано
            }
            Report("rmdir", rel);
            return Task.CompletedTask;
        });

        if (Volatile.Read(ref stopped))
        {
            await Rollback(dstRoot, stageRoot, journal);
            return new ApplyResult(done, total, failures, true, 0, unrecoverable);
        }

        // Дошли до конца - только теперь оригиналы стираются, одним действием на всю папку.
        var trashed = 0;
        var parkedList = journal.Stage.Concat(journal.Overwrite).Concat(journal.Conflict).ToList();
        // Решение «есть ли что выбрасывать» - по узлам, а вес обещаем по файлам.
        var parkedFiles = parkedList.Sum(WeightOf);
        if (parkedList.Count > 0)
        {
            if (orphans.Count == 0)
            {
                try
                {
                    await trashFn(stageRoot, parkedFiles);
                    trashed = parkedList.Count;
                }
                catch (Exception err)
                {
                    // Выбросить не удалось - служебную папку оставляем как есть: стереть её
                    // здесь значило бы уничтожить оригиналы молча.
                    Fail("trash", StageDir, err);
                }
            }
            else
            {
                // Внутри застрял чужой оригинал - убираем поимённо только своё; осечка на
                // одном не отменяет уборку остальных.
                await RunPool(parkedList, ApplyConcurrency, async rel =>
                {
                    try
                    {
                        await trashFn(Path.Join(stageRoot, rel), WeightOf(rel));
                        Interlocked.Increment(ref trashed);
                    }
                    catch (Exception err)
                    {
                        Fail("trash", rel, err);
                    }
                });
            }
            // Убираем каркас папок, если trashFn забрал только содержимое.
            RemoveStageIfEmpty(stageRoot);
        }
        else
        {
            // Выбрасывать нечего, но внутри мог застрять оригинал - такую папку не трогаем.
            RemoveStageIfEmpty(stageRoot);
        }

        return new ApplyResult(done, total, failures, false, trashed, unrecoverable);
    }

    // Разворачивает журнал в обратном порядке фаз.
    private static async Task Rollback(string dstRoot, string stageRoot, Journal journal)
    {
        string Abs(string rel) => Path.Join(dstRoot, rel);
        static void Quiet(Action a)
        {
            try { a(); } catch { /* вернуть не вышло - разберёт следующий запуск */ }
        }

        foreach (var rel in Enumerable.Reverse(journal.Rmdir)) Quiet(() => Mkdir(Abs(rel)));

        await RunPool(journal.Stage, ApplyConcurrency, rel =>
        {
            Quiet(() => Mkdir(Path.GetDirectoryName(Abs(rel))!));
            Quiet(() => Rename(Path.Join(stageRoot, rel), Abs(rel)));
            return Task.CompletedTask;
        });

        await RunPool(journal.Overwrite, ApplyConcurrency, rel =>
        {
            Quiet(() => { if (File.Exists(Abs(rel))) File.Delete(Abs(rel)); });
            Quiet(() => Rename(Path.Join(stageRoot, rel), Abs(rel)));
            return Task.CompletedTask;
        });

        await RunPool(journal.Copy, ApplyConcurrency, rel =>
        {
            Quiet(() => { if (File.Exists(Abs(rel))) File.Delete(Abs(rel)); });
            return Task.CompletedTask;
        });

        await RunPool(journal.Move, ApplyConcurrency, mv =>
        {
            Quiet(() => Mkdir(Path.GetDirectoryName(Abs(mv.From))!));
            Quiet(() => Rename(Abs(mv.To), Abs(mv.From)));
            return Task.CompletedTask;
        });

        foreach (var rel in Enumerable.Reverse(journal.Mkdir)) Quiet(() => Directory.Delete(Abs(rel), false));

        // Конфликтные узлы - последними: вернуть оригинал можно только теперь, когда
        // место освободилось.
        await RunPool(journal.Conflict, ApplyConcurrency, rel =>
        {
            Quiet(() => Mkdir(Path.GetDirectoryName(Abs(rel))!));
            try
            {
                Rename(Path.Join(stageRoot, rel), Abs(rel));
            }
            catch
            {
                // Место занято тем, что успел создать этот же запуск. Убираем помеху
                // и пробуем ещё раз - только после неудачной попытки, вслепую не удаляем.
                Quiet(() => RmForce(Abs(rel)));
                Quiet(() => Rename(Path.Join(stageRoot, rel), Abs(rel)));
            }
            return Task.CompletedTask;
        });

        // Если внутри что-то осталось, папку не трогаем - разберём на следующем запуске.
        RemoveStageIfEmpty(stageRoot);
    }
}
