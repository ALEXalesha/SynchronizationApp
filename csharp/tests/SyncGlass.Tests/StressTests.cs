using SyncGlass.Core;
using static SyncGlass.Tests.TestUtil;

namespace SyncGlass.Tests;

// Перенос test/stress.test.js: случайные изменения, остановка в любой точке,
// оборванный запуск в обратную сторону, масштаб.
public class StressTests
{
    // Снимок дерева: путь → содержимое (для папок - null).
    private static Dictionary<string, string?> Snapshot(string dir)
    {
        var outMap = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var rel in TreeOf(dir))
            outMap[rel] = rel.EndsWith('/') ? null : File.ReadAllText(Path.Join(dir, rel));
        return outMap;
    }

    private static bool Same(Dictionary<string, string?> a, Dictionary<string, string?> b)
        => a.Count == b.Count && a.All(kv => b.TryGetValue(kv.Key, out var v) && v == kv.Value);

    // Детерминированный генератор - тот же, что в JS, в тех же числах двойной точности:
    // s * 1103515245 выходит за 2^53, и JS считает его с округлением - повторяем его.
    private static Func<double> MakeRandom(double seed)
    {
        var s = seed;
        return () =>
        {
            s = (s * 1103515245 + 12345) % 2147483648;
            return s / 2147483648;
        };
    }

    private static (string[] Folders, List<string> Files) BuildTree(TempDir root, Func<double> rnd)
    {
        string[] folders = ["Док", "Док/2025", "Фото", "Фото/лето", "Архив"];
        foreach (var f in folders) root.Mkdir(f);
        var made = new List<string>();
        for (var i = 0; i < 30; i++)
        {
            var folder = folders[(int)Math.Floor(rnd() * folders.Length)];
            var rel = $"{folder}/файл{i}.txt";
            root.Write(rel, $"содержимое {i} {new string('z', (int)Math.Floor(rnd() * 50))}");
            made.Add(rel);
        }
        return (folders, made);
    }

    [Fact]
    public async Task случайные_изменения_после_синхронизации_деревья_совпадают_повтор_пуст()
    {
        for (var seed = 1; seed <= 6; seed++)
        {
            var rnd = MakeRandom(seed * 7919);
            using var src = new TempDir();
            using var dst = new TempDir();

            var (folders, files) = BuildTree(src, rnd);
            CopyTree(src.Root, dst.Root);

            // Перекладываем, переименовываем, меняем и удаляем - вперемешку.
            foreach (var rel in files)
            {
                var roll = rnd();
                if (roll < 0.25)
                {
                    var to = $"{folders[(int)Math.Floor(rnd() * folders.Length)]}/{Path.GetFileName(rel)}";
                    if (to != rel && !File.Exists(src.P(to))) File.Move(src.P(rel), src.P(to));
                }
                else if (roll < 0.4)
                {
                    File.WriteAllText(src.P(rel), $"изменено {rnd()}");
                    // Правку двигаем по времени вперёд: допуск сравнения дат 2 с.
                    File.SetLastWriteTimeUtc(src.P(rel), DateTime.UtcNow.AddHours(1));
                }
                else if (roll < 0.5)
                {
                    File.Delete(src.P(rel));
                }
            }
            src.Mkdir("СовсемНовая/Вложенная");
            src.Write("СовсемНовая/новьё.txt", "свежак");
            dst.Mkdir("Лишняя/Глубже");

            // Конфликты типа: и в корне выбранной ветки, и в глубине.
            src.Write("Док/узел/внутри.txt", "папка на источнике");
            dst.Write("Док/узел", "файл на приёмнике");
            dst.Write("Фото/лето/старое.jpg", "папка на приёмнике");
            Directory.Delete(src.P("Фото/лето"), true);
            src.Write("Фото/лето", "файл на источнике");

            string[] roots = ["Док", "Фото", "Архив", "СовсемНовая", "Лишняя"];
            var plan = await Plan.BuildRunPlan(src.Root, dst.Root, roots, [], LiveScan);
            var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash());

            Assert.True(res.Failures.Count == 0, $"seed {seed}: ошибки {string.Join(", ", res.Failures)}");
            Assert.True(Same(Snapshot(src.Root), Snapshot(dst.Root)), $"seed {seed}: деревья разошлись");

            var again = await Plan.BuildRunPlan(src.Root, dst.Root, roots, [], LiveScan);
            var left = again.Moves.Count + again.Copy.Count + again.Overwrite.Count + again.Trash.Count
                       + again.Dirs.Create.Count + again.Dirs.Remove.Count;
            Assert.True(left == 0, $"seed {seed}: повторный проход нашёл {left} действий");
        }
    }

    // Обрыв на N-м действии по всему диапазону: копирование, перезапись, удаление, папки.
    [Fact]
    public async Task остановка_в_любой_точке_возвращает_приёмник_ровно_в_исходное_состояние()
    {
        var cancelledRuns = 0;
        foreach (var stopAt in new[] { 1, 3, 7, 12, 20, 35, 60 })
        {
            var rnd = MakeRandom(stopAt * 104729);
            using var src = new TempDir();
            using var dst = new TempDir();

            BuildTree(src, rnd);
            CopyTree(src.Root, dst.Root);
            src.Write("Док/новый.txt", "новый файл");
            File.WriteAllText(src.P("Док/файл0.txt"), "перезаписанное содержимое");
            Directory.Move(src.P("Архив"), src.P("Архив2"));
            dst.Write("Лишний/мусор.txt", "выкинуть");
            src.Mkdir("ПустаяНовая");
            src.Write("Док/узел/внутри.txt", "папка на источнике");
            dst.Write("Док/узел", "файл на приёмнике");

            var before = Snapshot(dst.Root);
            string[] roots = ["Док", "Фото", "Архив", "Архив2", "Лишний", "ПустаяНовая"];
            var plan = await Plan.BuildRunPlan(src.Root, dst.Root, roots, [], LiveScan);

            var steps = 0;
            var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, MockTrash(), _ => Interlocked.Increment(ref steps),
                                            () => Volatile.Read(ref steps) >= stopAt);

            if (!res.Cancelled) continue; // работы оказалось меньше, чем точка останова
            cancelledRuns++;
            Assert.True(Same(before, Snapshot(dst.Root)), $"stopAt {stopAt}: приёмник не вернулся в исходное состояние");
            Assert.False(Exists(dst.Root, FsOps.StageDir), $"stopAt {stopAt}: осталась служебная папка");
        }
        // Нового в C#: закон обязан хоть раз дойти до своего случая.
        Assert.True(cancelledRuns >= 4, $"остановка сработала лишь в {cancelledRuns} прогонах из 7");
    }

    // Вылет посреди синхронизации A → B, затем B → A: без разбора служебной папки
    // оригинал выглядел бы удалённым на источнике и стёрся бы и в A.
    [Fact]
    public async Task оборванный_запуск_в_обратную_сторону_оригиналы_не_считаются_пропавшими()
    {
        using var a = new TempDir();
        using var b = new TempDir();
        a.Write("Док/важное.txt", "ценные данные");
        b.Write("Док/важное.txt", "ценные данные");

        b.Mkdir($"{FsOps.StageDir}/Док");
        File.Move(b.P("Док/важное.txt"), b.P($"{FsOps.StageDir}/Док/важное.txt"));

        foreach (var root in new[] { b, a }) await FsOps.RestoreStage(root.Root);

        var plan = await Plan.BuildRunPlan(b.Root, a.Root, ["Док"], [], LiveScan);
        Assert.Empty(plan.Trash);
        await FsOps.ApplyPlan(b.Root, a.Root, plan, MockTrash());
        Assert.Equal("ценные данные", Read(a.Root, "Док/важное.txt"));
    }

    [Fact]
    public async Task файл_нельзя_отложить_удаление_идёт_напрямую_синхронизация_не_встаёт()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Write("остаётся.txt", "ок");
        dst.Write("остаётся.txt", "ок");
        dst.Write("лишний.txt", "выкинуть");

        var plan = await Plan.BuildRunPlan(src.Root, dst.Root, ["остаётся.txt", "лишний.txt"], [], LiveScan);
        // Занимаем имя служебной папки файлом: mkdir внутрь него не пройдёт.
        dst.Write(FsOps.StageDir, "занято");

        var trashed = new List<string>();
        var res = await FsOps.ApplyPlan(src.Root, dst.Root, plan, (abs, _) =>
        {
            lock (trashed) trashed.Add(Path.GetFileName(abs));
            FsOps.RmForce(abs);
            return Task.CompletedTask;
        });

        Assert.Empty(res.Failures);
        Assert.Equal(1, res.Unrecoverable);
        Assert.Equal(["лишний.txt"], trashed);
        Assert.False(Exists(dst.Root, "лишний.txt"));
    }

    // Ветка с сотнями тысяч файлов сливается в общий план (в JS ломался push(...arr)).
    [Fact]
    public async Task масштаб_ветка_на_200k_файлов_сливается_в_общий_план()
    {
        using var src = new TempDir();
        using var dst = new TempDir();
        src.Mkdir("big");
        dst.Mkdir("big");

        const int N = 200000;
        var files = new List<FileEntry>(N);
        var dirs = new List<string>(N);
        for (var i = 0; i < N; i++)
        {
            files.Add(new FileEntry($"f{i}.bin", 10, 1000));
            dirs.Add($"d{i}");
        }
        Scanner hugeScan = (_, _, _) => Task.FromResult(new ScanResult(files, dirs, []));

        var plan = await Plan.BuildRunPlan(src.Root, dst.Root, ["big"], [], hugeScan);
        Assert.Equal(N, plan.Unchanged.Count);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Trash);
        Assert.Empty(plan.Dirs.Create);
        Assert.Empty(plan.Dirs.Remove);
    }
}
