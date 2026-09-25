using SyncGlass.Core;
using SyncGlass.Core.Main;

namespace SyncGlass.Tests;

// Перенос test/invariants.test.js: дифференциальные прогоны на случайных деревьях -
// не «проверить сценарий», а «сформулировать закон и попробовать его сломать».
// Генератор тот же, что в JS, до бита: деревья в C# и в JS получаются одинаковые,
// и упавший прогон можно повторить в обеих версиях.
//
// Здесь все тринадцать законов. Два с кликами по дереву («что отмечено на экране…»,
// «раскладка индекса по веткам…») кликают через ту же модель выбора, что и окно
// (MainViewModel); «имя с диска не становится разметкой» - в ViewModelTests: в WPF разметки нет.
public class InvariantsTests
{
    // ---- Генератор (как в JS: seed = (seed * 1103515245 + 12345) & 0x7fffffff) ----
    // Умножение в JS - в числах двойной точности и уже за 2^53, а & режет по модулю
    // 2^32 - повторяем ровно это, иначе деревья разошлись бы с JS.
    private sealed class Rnd(long seed)
    {
        private long _seed = seed;

        public double Next()
        {
            var v = _seed * 1103515245.0 + 12345;
            _seed = (long)(v % 4294967296.0) & 0x7fffffff;
            return _seed / (double)0x7fffffff;
        }

        public T Pick<T>(IReadOnlyList<T> arr) => arr[(int)Math.Floor(Next() * arr.Count)];
    }

    // Имена нарочно пересекаются по регистру и годятся и для папки, и для файла.
    private static readonly string[] Names = ["a", "b", "c", "Doc", "doc", "x.txt", "y.txt", "Z.txt", "sub", "Sub"];

    private static void MakeTree(Rnd r, string root, int depth = 0)
    {
        var n = (int)Math.Floor(r.Next() * 4);
        for (var i = 0; i < n; i++)
        {
            var name = r.Pick(Names);
            var p = Path.Join(root, name);
            var isDir = depth < 3 && r.Next() < 0.45;
            try
            {
                if (isDir)
                {
                    Directory.CreateDirectory(p);
                    MakeTree(r, p, depth + 1);
                }
                else
                {
                    File.WriteAllText(p, new string('c', (int)Math.Floor(r.Next() * 40)) + name);
                }
            }
            catch
            {
                // имя уже занято узлом другого типа - это тоже часть случая
            }
        }
    }

    private static void MakeDenseTree(Rnd r, string root, int depth = 0)
    {
        var n = 1 + (int)Math.Floor(r.Next() * 3);
        for (var i = 0; i < n; i++)
        {
            var name = r.Pick(Names) + i;
            var p = Path.Join(root, name);
            try
            {
                if (depth < 3 && r.Next() < 0.55)
                {
                    Directory.CreateDirectory(p);
                    MakeDenseTree(r, p, depth + 1);
                }
                else
                {
                    File.WriteAllText(p, new string('c', (int)Math.Floor(r.Next() * 40)) + name);
                }
            }
            catch
            {
                // имя уже занято узлом другого типа
            }
        }
    }

    private static List<(string Name, bool IsDir)> Children(string dir)
    {
        try
        {
            return new DirectoryInfo(dir).EnumerateFileSystemInfos("*", new EnumerationOptions { AttributesToSkip = 0 })
                .Select(i => (i.Name, i.Attributes.HasFlag(FileAttributes.Directory))).ToList();
        }
        catch
        {
            return new List<(string, bool)>();
        }
    }

    // Приёмник - искажённая копия источника: перезаписи, конфликты типов, папки,
    // написанные иначе, и лишнее, которого на источнике нет.
    private static void PerturbedCopy(Rnd r, string src, string dst, string rel = "")
    {
        if (!Directory.Exists(Path.Join(src, rel))) return;
        var dirents = Children(Path.Join(src, rel));
        Directory.CreateDirectory(Path.Join(dst, rel));
        foreach (var (name, isDir) in dirents)
        {
            var rr = rel != "" ? $"{rel}/{name}" : name;
            var roll = r.Next();
            try
            {
                if (roll < 0.08) continue; // на приёмнике этого узла нет
                if (isDir)
                {
                    if (roll < 0.13)
                    {
                        File.WriteAllText(Path.Join(dst, rr), "на приёмнике это файл");
                        continue;
                    }
                    // Написание папки расходится со стороной-источником (как toUpperCase в JS).
                    var n = roll < 0.5 ? name.ToUpperInvariant() : name;
                    Directory.CreateDirectory(Path.Join(dst, rel != "" ? $"{rel}/{n}" : n));
                    PerturbedCopy(r, src, dst, rr);
                }
                else
                {
                    if (roll < 0.13)
                    {
                        Directory.CreateDirectory(Path.Join(dst, rr));
                        continue;
                    }
                    var body = File.ReadAllText(Path.Join(src, rr));
                    File.WriteAllText(Path.Join(dst, rr), roll < 0.3 ? body + "!" : body);
                }
            }
            catch
            {
                // имя уже занято узлом другого типа
            }
        }

        var лишних = (int)Math.Floor(r.Next() * 3);
        for (var i = 0; i < лишних; i++)
        {
            var имя = $"лишнее{i}-{(int)Math.Floor(r.Next() * 1000)}";
            try
            {
                if (r.Next() < 0.35)
                {
                    Directory.CreateDirectory(Path.Join(dst, rel, имя));
                    File.WriteAllText(Path.Join(dst, rel, имя, "внутри.txt"), "лишнее внутри лишней папки");
                }
                else
                {
                    File.WriteAllText(Path.Join(dst, rel, имя), "этого нет на источнике");
                }
            }
            catch
            {
                // имя уже занято
            }
        }
    }

    // Снимок дерева: путь без учёта регистра → содержимое файла или '/' для папки.
    private static Dictionary<string, string> Snap(string root)
    {
        var outMap = new Dictionary<string, string>(StringComparer.Ordinal);
        void Walk(string rel)
        {
            foreach (var (name, isDir) in Children(Path.Join(root, rel)))
            {
                if (name == FsOps.StageDir) continue;
                var r = rel != "" ? $"{rel}/{name}" : name;
                if (isDir)
                {
                    outMap[Paths.CiKey(r)] = "/";
                    Walk(r);
                }
                else
                {
                    try { outMap[Paths.CiKey(r)] = File.ReadAllText(Path.Join(root, r)); } catch { outMap[Paths.CiKey(r)] = "?"; }
                }
            }
        }
        Walk("");
        return outMap;
    }

    private static List<string> DiffOf(Dictionary<string, string> want, Dictionary<string, string> got)
    {
        var outList = new List<string>();
        foreach (var (k, v) in want)
            if (!got.TryGetValue(k, out var g) || g != v) outList.Add($"{k}: ждали {v}, лежит {(got.TryGetValue(k, out var x) ? x : "—")}");
        foreach (var k in got.Keys)
            if (!want.ContainsKey(k)) outList.Add($"лишнее: {k}");
        return outList;
    }

    // Сканер в том виде, в каком его собирает main.js: исключения относительно ветки.
    private static readonly Scanner Scanner = async (root, branch, excludes) =>
    {
        var prefix = branch != "" ? branch + "/" : "";
        var set = new List<string>();
        foreach (var ex in excludes)
        {
            if (prefix != "" && ex.Length > prefix.Length && Paths.CiKey(ex[..prefix.Length]) == Paths.CiKey(prefix)) set.Add(ex[prefix.Length..]);
            else if (prefix == "") set.Add(ex);
        }
        var dirs = new List<string>();
        var skipped = new List<string>();
        var files = await FsOps.ScanFiles(Path.Join(root, branch), "", null, set, null, dirs, skipped);
        return new ScanResult(files, dirs, skipped);
    };

    private static readonly TrashFn RmTrash = (p, _) =>
    {
        FsOps.RmForce(p);
        return Task.CompletedTask;
    };

    private sealed class Sides : IDisposable
    {
        public readonly TempDir Base = new();
        public string Src => Base.P("src");
        public string Dst => Base.P("dst");

        public Sides()
        {
            Directory.CreateDirectory(Src);
            Directory.CreateDirectory(Dst);
        }

        public void Dispose() => Base.Dispose();
    }

    // Две случайные стороны и ветки верхнего уровня с обеих.
    private static (Sides S, List<string> Folders) Build(Rnd r)
    {
        var s = new Sides();
        MakeTree(r, s.Src);
        MakeTree(r, s.Dst);
        var names = new List<string>();
        foreach (var root in new[] { s.Src, s.Dst })
            foreach (var (name, _) in Children(root))
                if (!names.Contains(name)) names.Add(name);
        return (s, names);
    }

    // Ветки верхнего уровня, схлопнутые по регистру - как их собирает list-folders.
    private static List<string> ВерхниеВетки(params string[] roots)
    {
        var поКлючу = new Dictionary<string, string>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var root in roots)
            foreach (var (d, _) in Children(root))
            {
                if (d == FsOps.StageDir) continue;
                if (поКлючу.TryAdd(Paths.CiKey(d), d)) order.Add(Paths.CiKey(d));
            }
        return order.Select(k => поКлючу[k]).ToList();
    }

    private static List<string> AllPaths(string root)
    {
        var outList = new List<string>();
        void Walk(string rel)
        {
            foreach (var (name, isDir) in Children(Path.Join(root, rel)))
            {
                var r = rel != "" ? $"{rel}/{name}" : name;
                outList.Add(r);
                if (isDir) Walk(r);
            }
        }
        Walk("");
        return outList;
    }

    private static async Task<CrawlSide> IndexOfSide(string root)
    {
        var files = new Dictionary<string, (long, double)>(StringComparer.Ordinal);
        var dirs = new HashSet<string>(StringComparer.Ordinal);
        var skipped = new List<string>();
        await FsOps.CrawlTree(root, "", (rel, isFolder, size, _, mtime) =>
        {
            lock (files)
            {
                if (isFolder) dirs.Add(rel);
                else files[rel] = (size, mtime ?? 0);
            }
        }, skipped);
        return new CrawlSide(files, dirs, skipped);
    }

    [Fact]
    public async Task приёмник_становится_точной_копией_источника()
    {
        for (var i = 1; i <= 40; i++)
        {
            var r = new Rnd(i * 7919);
            var (s, folders) = Build(r);
            using var _ = s;
            if (folders.Count == 0) continue;

            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, [], Scanner);
            var res = await FsOps.ApplyPlan(s.Src, s.Dst, plan, RmTrash);

            Assert.True(res.Failures.Count == 0, $"прогон {i}: ошибки на ровном месте: {string.Join(", ", res.Failures)}");
            var diff = DiffOf(Snap(s.Src), Snap(s.Dst));
            Assert.True(diff.Count == 0, $"прогон {i}: стороны разошлись: {string.Join("; ", diff)}");
            Assert.False(Directory.Exists(Path.Join(s.Dst, FsOps.StageDir)), $"прогон {i}: служебная папка не убрана");
        }
    }

    [Fact]
    public async Task второй_прогон_не_находит_работы_в_том_числе_с_исключениями()
    {
        for (var i = 1; i <= 40; i++)
        {
            var r = new Rnd(i * 7919 + 13);
            var (s, folders) = Build(r);
            using var _ = s;
            if (folders.Count == 0) continue;
            var excludes = AllPaths(s.Src).Where(_ => r.Next() < 0.12).ToList();

            var first = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, Scanner);
            await FsOps.ApplyPlan(s.Src, s.Dst, first, RmTrash);
            var second = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, Scanner);

            Assert.True(Sync.Summarize(second).Total == 0, $"прогон {i}: повтор нашёл работу (исключения: {string.Join(",", excludes)})");
        }
    }

    [Fact]
    public async Task остановка_в_любой_точке_возвращает_приёмник_ровно_в_исходное_состояние()
    {
        var остановок = 0;
        for (var i = 1; i <= 40; i++)
        {
            var r = new Rnd(i * 104729 + 5);
            var (s, folders) = Build(r);
            using var _ = s;
            if (folders.Count == 0) continue;

            var before = Snap(s.Dst);
            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, [], Scanner);
            var total = Sync.Summarize(plan).Total;
            if (total == 0) continue;

            var stopAt = (int)Math.Floor(r.Next() * total);
            var done = 0;
            var res = await FsOps.ApplyPlan(s.Src, s.Dst, plan, RmTrash, _ => Interlocked.Increment(ref done),
                                            () => Volatile.Read(ref done) >= stopAt);
            if (!res.Cancelled) continue;
            остановок++;

            // Сверяем сразу, без RestoreStage: разбор служебной папки вернул бы то, что
            // не вернул откат, и сломанный откат прошёл бы незамеченным.
            var diff = DiffOf(before, Snap(s.Dst));
            Assert.True(diff.Count == 0, $"прогон {i}: остановка на {stopAt}/{total} не вернула приёмник: {string.Join("; ", diff)}");
            Assert.False(Directory.Exists(Path.Join(s.Dst, FsOps.StageDir)), $"прогон {i}: после отката осталась служебная папка");
        }
        Assert.True(остановок >= 15, $"остановка сработала лишь в {остановок} прогонах - генератор до случая не доходит");
    }

    [Fact]
    public async Task предпросмотр_не_врёт_сумма_по_веткам_сходится_а_повтор_пуст()
    {
        for (var i = 1; i <= 40; i++)
        {
            var r = new Rnd(i * 7919 + 57);
            using var s = new Sides();
            MakeDenseTree(r, s.Src);
            PerturbedCopy(r, s.Src, s.Dst);

            var folders = Children(s.Src).Select(c => c.Name).ToList();
            if (folders.Count == 0) continue;
            var excludes = AllPaths(s.Src).Where(p => p.Contains('/') && r.Next() < 0.12).ToList();

            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, Scanner);
            var totals = Sync.Summarize(plan);
            var sum = Plan.CountByFolder(plan, folders).Sum(pf => pf.Summary.Total);
            Assert.True(sum == totals.Total, $"прогон {i}: сумма по веткам {sum} != итог {totals.Total}");

            var res = await FsOps.ApplyPlan(s.Src, s.Dst, plan, RmTrash);
            Assert.True(res.Failures.Count == 0, $"прогон {i}: ошибки на ровном месте: {string.Join(", ", res.Failures)}");

            var again = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, Scanner);
            Assert.True(Sync.Summarize(again).Total == 0, $"прогон {i}: повтор нашёл работу (исключения: {string.Join(",", excludes)})");
        }
    }

    [Fact]
    public async Task план_по_индексу_обхода_совпадает_с_планом_по_живому_скану()
    {
        static string Shape(SyncPlan p)
        {
            static string L(IEnumerable<string> xs) => string.Join(",", xs.Select(Paths.CiKey).OrderBy(x => x, StringComparer.Ordinal));
            return string.Join("|", L(p.Copy.Select(e => e.Path)), L(p.Overwrite.Select(e => e.Path)), L(p.Trash.Select(e => e.Path)),
                L(p.Moves.Select(m => $"{m.From}→{m.To}")), L(p.Dirs.Create), L(p.Dirs.Remove), L(p.Conflicts), L(p.Skipped));
        }

        for (var i = 1; i <= 40; i++)
        {
            var r = new Rnd(i * 7919 + 31);
            var (s, folders) = Build(r);
            using var _ = s;
            if (folders.Count == 0) continue;
            var excludes = AllPaths(s.Src).Where(_ => r.Next() < 0.15).ToList();

            var idx = new Dictionary<string, CrawlSide> { [s.Src] = await IndexOfSide(s.Src), [s.Dst] = await IndexOfSide(s.Dst) };
            Scanner byIndex = (root, branch, ex) => Task.FromResult(Plan.ScanFromIndex(idx[root], branch, ex));

            var live = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, Scanner);
            var indexed = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, byIndex);

            Assert.True(Shape(indexed) == Shape(live), $"прогон {i}: скан и индекс разошлись\nскан:   {Shape(live)}\nиндекс: {Shape(indexed)}");
        }
    }

    // Имитация вылета посреди работы: часть файлов остаётся в служебной папке.
    private static void CrashLeftovers(Rnd r, string root)
    {
        foreach (var rel in AllPaths(root))
        {
            if (rel == FsOps.StageDir || rel.StartsWith(FsOps.StageDir + "/", StringComparison.Ordinal)) continue;
            if (r.Next() > 0.25) continue;
            try
            {
                if (!File.Exists(Path.Join(root, rel))) continue;
                var parked = Path.Join(root, FsOps.StageDir, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(parked)!);
                File.Move(Path.Join(root, rel), parked);
            }
            catch
            {
                // не вышло отложить - этот файл просто не участвует в имитации
            }
        }
    }

    // Направление, точка обрыва и вылет - случайные; законов три: источник не трогают
    // никогда, оборванный прогон возвращает приёмник, доведённый - сводит стороны.
    [Fact]
    public async Task цепочка_прогонов_в_обе_стороны_с_обрывами_и_вылетами_ничего_не_теряет()
    {
        for (var i = 1; i <= 30; i++)
        {
            var r = new Rnd(i * 7919 + 211);
            var (s, _) = Build(r);
            using var __ = s;
            var (a, b) = (s.Src, s.Dst);

            for (var step = 1; step <= 4; step++)
            {
                var метка = $"прогон {i}, шаг {step}";
                var вылет = r.Next() < 0.35;
                var доВылета = вылет ? (Snap(a), Snap(b)) : default;
                if (вылет) CrashLeftovers(r, r.Next() < 0.5 ? a : b);

                foreach (var root in new[] { a, b }) await FsOps.RestoreStage(root);
                if (вылет)
                {
                    var d1 = DiffOf(доВылета.Item1, Snap(a));
                    var d2 = DiffOf(доВылета.Item2, Snap(b));
                    Assert.True(d1.Count == 0 && d2.Count == 0, $"{метка}: разбор служебной папки не вернул отложенное на место");
                }

                var toB = r.Next() < 0.5;
                var from = toB ? a : b;
                var to = toB ? b : a;
                var names = new List<string>();
                foreach (var root in new[] { a, b })
                    foreach (var (d, _) in Children(root))
                        if (d != FsOps.StageDir && !names.Contains(d)) names.Add(d);
                if (names.Count == 0) continue;

                var былоНаИсточнике = Snap(from);
                var былоНаПриёмнике = Snap(to);
                var plan = await Plan.BuildRunPlan(from, to, names, [], Scanner);
                var total = Sync.Summarize(plan).Total;

                var stopAt = r.Next() < 0.5 ? (int)Math.Floor(r.Next() * (total + 1)) : total + 1;
                var done = 0;
                var res = await FsOps.ApplyPlan(from, to, plan, RmTrash, _ => Interlocked.Increment(ref done),
                                                () => Volatile.Read(ref done) >= stopAt);

                Assert.True(DiffOf(былоНаИсточнике, Snap(from)).Count == 0, $"{метка}: источник изменился, а трогать его нельзя никогда");
                if (res.Cancelled)
                {
                    var diff = DiffOf(былоНаПриёмнике, Snap(to));
                    Assert.True(diff.Count == 0, $"{метка}: обрыв на {stopAt}/{total} не вернул приёмник: {string.Join("; ", diff)}");
                }
                else
                {
                    var diff = DiffOf(Snap(from), Snap(to));
                    Assert.True(diff.Count == 0, $"{метка}: доведённый до конца прогон не свёл стороны: {string.Join("; ", diff)}");
                }
            }
        }
    }

    // Порча посреди работы по счётчику действий: «на каком шаге дерево дрогнуло» - часть
    // засеянного случая. В C# прогресс зовётся синхронно, поэтому и порча синхронная -
    // упавший прогон повторяется дословно. Возвращает, что тронула на приёмнике.
    private static void Vandalize(Rnd r, string root, HashSet<string>? тронутые, List<string> цели)
    {
        var файлы = AllPaths(root).Where(rel => rel != FsOps.StageDir && !rel.StartsWith(FsOps.StageDir + "/", StringComparison.Ordinal)).ToList();
        if (файлы.Count == 0) return;
        var вПлане = цели.Where(c => файлы.Any(f => Paths.CiKey(f) == Paths.CiKey(c))).ToList();
        var rel = вПлане.Count > 0 && r.Next() < 0.75 ? r.Pick(вПлане) : r.Pick(файлы);
        тронутые?.Add(Paths.CiKey(rel));
        var abs = Path.Join(root, rel);
        var бросок = r.Next();
        try
        {
            if (Directory.Exists(abs))
            {
                // Папку сносим целиком: посреди работы исчезает не файл, а ветка.
                if (бросок < 0.5) Directory.Delete(abs, true);
                return;
            }
            if (!File.Exists(abs)) return;
            if (бросок < 0.35) File.Delete(abs);
            else if (бросок < 0.6) File.WriteAllText(abs, $"дописано {r.Next()}");
            else if (бросок < 0.8)
            {
                // Файл сменился папкой прямо под руками.
                File.Delete(abs);
                Directory.CreateDirectory(abs);
                File.WriteAllText(Path.Join(abs, "подменыш.txt"), "этого не было в плане");
            }
            else File.WriteAllText(Path.Join(root, rel + ".новый"), "появился по ходу работы");
        }
        catch
        {
            // не вышло испортить - этот шаг проходит спокойно
        }
    }

    [Fact]
    public async Task дерево_изменившееся_посреди_работы_не_уносит_с_собой_чужие_файлы()
    {
        for (var i = 1; i <= 60; i++)
        {
            var r = new Rnd(i * 7919 + 503);
            using var s = new Sides();
            MakeDenseTree(r, s.Src);
            PerturbedCopy(r, s.Src, s.Dst);
            var folders = ВерхниеВетки(s.Src, s.Dst);
            if (folders.Count == 0) continue;

            var доПрогона = Snap(s.Dst);
            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, [], Scanner);
            var total = Sync.Summarize(plan).Total;
            if (total == 0) continue;

            var вПлане = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in plan.Trash.Concat(plan.Copy).Concat(plan.Overwrite)) вПлане.Add(Paths.CiKey(e.Path));
            foreach (var m in plan.Moves)
            {
                вПлане.Add(Paths.CiKey(m.From));
                вПлане.Add(Paths.CiKey(m.To));
            }
            var конфликты = plan.Conflicts.Select(Paths.CiKey).ToList();
            var запланированоУбрать = new HashSet<string>(plan.Trash.Select(e => Paths.CiKey(e.Path)).Concat(plan.Moves.Select(m => Paths.CiKey(m.From))), StringComparer.Ordinal);

            var порчаНа = new HashSet<int> { 1 };
            var точек = Math.Min(3, total);
            while (порчаНа.Count < точек) порчаНа.Add(1 + (int)Math.Floor(r.Next() * total));
            var испорченоНаПриёмнике = new HashSet<string>(StringComparer.Ordinal);
            var целиИсточника = plan.Overwrite.Select(e => e.Path).Concat(plan.Copy.Select(e => e.Path)).ToList();
            var целиПриёмника = plan.Overwrite.Select(e => e.Path).Concat(plan.Trash.Select(e => e.Path)).ToList();
            Exception? сорвалось = null;
            try
            {
                await FsOps.ApplyPlan(s.Src, s.Dst, plan, RmTrash, p =>
                {
                    if (!порчаНа.Contains(p.Done)) return;
                    // На первом шаге сносим с источника файл, обещанный к перезаписи: самая
                    // злая из гонок - оригинал приёмника уже отложен, и его обязаны вернуть.
                    if (p.Done == 1 && plan.Overwrite.Count > 0)
                    {
                        try { File.Delete(Path.Join(s.Src, r.Pick(plan.Overwrite).Path)); } catch { /* ok */ }
                        return;
                    }
                    if (r.Next() < 0.5) Vandalize(r, s.Dst, испорченоНаПриёмнике, целиПриёмника);
                    else Vandalize(r, s.Src, null, целиИсточника);
                });
            }
            catch (Exception err)
            {
                сорвалось = err;
            }
            bool Испорчено(string k) => испорченоНаПриёмнике.Any(p => k == p || k.StartsWith(p + "/", StringComparison.Ordinal));
            Assert.True(сорвалось == null, $"прогон {i}: работа сорвалась исключением вместо осечки ({сорвалось?.Message})");

            var послеПрогона = Snap(s.Dst);
            var тронуто = new List<string>();
            var пропало = new List<string>();
            foreach (var (k, v) in доПрогона)
            {
                if (v == "/" || Испорчено(k)) continue;
                var вКонфликте = конфликты.Any(c => k == c || k.StartsWith(c + "/", StringComparison.Ordinal));
                послеПрогона.TryGetValue(k, out var стало);
                if (стало != v && !вПлане.Contains(k) && !вКонфликте) тронуто.Add($"{k}: было {v}, стало {стало}");
                if (стало != null) continue;
                if (запланированоУбрать.Contains(k) || вКонфликте) continue;
                пропало.Add(k);
            }
            Assert.True(тронуто.Count == 0, $"прогон {i}: правка на ходу утащила файл, которого не было в плане: {string.Join("; ", тронуто)}");
            Assert.True(пропало.Count == 0, $"прогон {i}: файл исчез с приёмника, хотя убирать его никто не собирался: {string.Join("; ", пропало)}");
        }
    }

    private static int CountFilesUnder(string abs)
    {
        if (!Directory.Exists(abs)) return 1;
        var n = 0;
        foreach (var (name, isDir) in Children(abs)) n += isDir ? CountFilesUnder(Path.Join(abs, name)) : 1;
        return n;
    }

    [Fact]
    public async Task вес_вызова_Корзины_равен_числу_файлов_которые_этот_вызов_уносит()
    {
        for (var i = 1; i <= 40; i++)
        {
            var r = new Rnd(i * 7919 + 607);
            using var s = new Sides();
            MakeDenseTree(r, s.Src);
            PerturbedCopy(r, s.Src, s.Dst);
            var folders = ВерхниеВетки(s.Src, s.Dst);
            if (folders.Count == 0) continue;

            var обещано = 0;
            var унесено = 0;
            TrashFn считающая = (abs, вес) =>
            {
                Interlocked.Add(ref обещано, вес);
                Interlocked.Add(ref унесено, CountFilesUnder(abs));
                FsOps.RmForce(abs);
                return Task.CompletedTask;
            };

            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, [], Scanner);
            if (Sync.Summarize(plan).Total == 0) continue;
            await FsOps.ApplyPlan(s.Src, s.Dst, plan, считающая);

            Assert.True(обещано == унесено, $"прогон {i}: обещали вес {обещано}, а унесли {унесено} файлов");
        }
    }

    // Самый ценный закон: вся защита от потери данных построена на служебной папке
    // и журнале, а проверить её можно только отказами. Каждая пятая запись падает.
    [Fact]
    public async Task при_падающих_файловых_операциях_ни_один_файл_не_исчезает_с_обеих_сторон()
    {
        var отказов = 0;
        var перезаписей = 0;
        for (var i = 1; i <= 60; i++)
        {
            var r = new Rnd(i * 7919 + 101);
            // Каждый второй прогон приёмник - искажённая копия источника. На двух
            // независимых деревьях перезаписей почти нет, и возврат оригинала после
            // сорвавшейся перезаписи закон не проверял вовсе: мутации «не возвращать
            // оригинал» и «выбросить служебную папку вместе с застрявшим» проходили
            // зелёными (найдено 26.09.2026 при переносе на C#; в JS та же дыра).
            Sides s;
            List<string> folders;
            if (i % 2 == 0)
            {
                s = new Sides();
                MakeDenseTree(r, s.Src);
                PerturbedCopy(r, s.Src, s.Dst);
                folders = ВерхниеВетки(s.Src, s.Dst);
            }
            else
            {
                (s, folders) = Build(r);
            }
            using var _ = s;
            if (folders.Count == 0) continue;

            var before = Snap(s.Dst);
            var srcSnap = Snap(s.Src);
            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, [], Scanner);
            var trash = new HashSet<string>(plan.Trash.Select(e => Paths.CiKey(e.Path)), StringComparer.Ordinal);
            var moveFrom = new HashSet<string>(plan.Moves.Select(m => Paths.CiKey(m.From)), StringComparer.Ordinal);
            var conflicts = plan.Conflicts.Select(Paths.CiKey).ToList();
            перезаписей += plan.Overwrite.Count;

            var gate = new object();
            string[] codes = ["EPERM", "EBUSY", "ENAMETOOLONG"];
            FsOps.WriteFault.Value = op =>
            {
                lock (gate)
                {
                    if (r.Next() >= 0.2) return null;
                    отказов++;
                    return new FsException(r.Pick(codes), $"отказ {op}");
                }
            };
            try
            {
                await FsOps.ApplyPlan(s.Src, s.Dst, plan, RmTrash);
            }
            finally
            {
                FsOps.WriteFault.Value = null;
            }
            await FsOps.RestoreStage(s.Dst);

            var after = Snap(s.Dst);
            var lost = new List<string>();
            foreach (var (k, v) in before)
            {
                if (v == "/") continue;
                after.TryGetValue(k, out var стало);
                if (стало == v) continue;                    // цел
                if (trash.Contains(k)) continue;             // запланирован к удалению
                if (moveFrom.Contains(k)) continue;          // переехал по плану
                if (conflicts.Any(c => k == c || k.StartsWith(c + "/", StringComparison.Ordinal))) continue;
                if (srcSnap.TryGetValue(k, out var src) && стало == src) continue; // заменён версией источника
                lost.Add($"{k}: было {v}, стало {стало ?? "—"}");
            }
            Assert.True(lost.Count == 0, $"прогон {i}: файл пропал при отказах: {string.Join("; ", lost)}");
        }
        Assert.True(отказов > 50, $"отказов всего {отказов} - закон до своего случая не доходит");
        Assert.True(перезаписей >= 20, $"перезаписей всего {перезаписей} - возврат оригинала закон не проверяет");
    }

    // «Предпросмотр не врёт» есть, а это - «история не врёт»: каждая строка записи
    // подтверждается диском, и каждый изменившийся файл назван в записи.
    [Fact]
    public async Task история_не_врёт_перечисленное_в_записи_совпадает_с_тем_что_стало_с_диском()
    {
        using var userData = new TempDir();
        var b = new Backend(userData.Root);
        for (var i = 1; i <= 20; i++)
        {
            var r = new Rnd(i * 7919 + 401);
            using var s = new Sides();
            MakeDenseTree(r, s.Src);
            PerturbedCopy(r, s.Src, s.Dst);
            var folders = ВерхниеВетки(s.Src, s.Dst);
            if (folders.Count == 0) continue;

            // Направление чередуем: какая сторона «локальная», решает направление.
            var кСети = i % 2 == 1;
            var args = new SyncArgs(кСети ? s.Src : s.Dst, кСети ? s.Dst : s.Src, folders, [], кСети ? "toNetwork" : "toLocal");
            var до = Snap(s.Dst);
            var наИсточнике = Snap(s.Src);
            await b.ClearHistory();
            var pv = await b.Preview(args);
            var res = await b.Sync(args);
            Assert.True(res.Error == null, $"прогон {i}: синхронизация не прошла ({res.Error})");
            var после = Snap(s.Dst);
            var history = await b.GetHistory();

            if (pv.Totals!.Total == 0)
            {
                Assert.True(history.Count == 0, $"прогон {i}: пустой прогон оставил запись");
                continue;
            }
            var запись = history[0];
            var t = запись.Totals!;
            Assert.True((t.Move, t.Copy, t.Overwrite, t.Trash, t.Dirs) == (pv.Totals.Move, pv.Totals.Copy, pv.Totals.Overwrite, pv.Totals.Trash, pv.Totals.Dirs),
                $"прогон {i}: итоги записи разошлись с предпросмотром");

            var врёт = new List<string>();
            var названо = new HashSet<string>(StringComparer.Ordinal);
            foreach (var f in запись.Files!)
            {
                var пути = f.Action == "move" ? f.Path.Split(" → ") : [f.Path];
                foreach (var p in пути) названо.Add(Paths.CiKey(p));
                var цель = Paths.CiKey(пути[^1]);
                после.TryGetValue(цель, out var стало);
                if (f.Action == "trash")
                {
                    до.TryGetValue(цель, out var было);
                    if (стало == было) врёт.Add($"{f.Path}: отчитались об удалении, а узел на месте");
                }
                else if (стало == null) врёт.Add($"{f.Path}: отчитались о «{f.Action}», а такого узла на приёмнике нет");
                else if (стало != (наИсточнике.TryGetValue(цель, out var src) ? src : null)) врёт.Add($"{f.Path}: отчитались о «{f.Action}», а на приёмнике {стало}");
            }
            Assert.True(врёт.Count == 0, $"прогон {i}: запись обещает то, чего на диске нет: {string.Join("; ", врёт)}");

            if (запись.FilesTruncated == 0)
            {
                var умолчали = new List<string>();
                foreach (var ключ in до.Keys.Concat(после.Keys).Distinct())
                {
                    до.TryGetValue(ключ, out var было);
                    после.TryGetValue(ключ, out var стало);
                    if (было == стало) continue;
                    if (было == "/" || стало == "/") continue;
                    if (!названо.Contains(ключ)) умолчали.Add($"{ключ}: {было} → {стало}");
                }
                Assert.True(умолчали.Count == 0, $"прогон {i}: файл изменился, а в истории о нём ни слова: {string.Join("; ", умолчали)}");
            }
        }
    }

    // ---- Законы с кликами по дереву (через ту же модель выбора, что у окна) ----

    // Ветки и исключения, какими их порождает интерфейс: последствие кликов, а не
    // случайный список путей. Только так рождается «выбрано, внутри снято, ещё глубже
    // снова выбрано» - единственный способ получить две вложенные ветки разом.
    private static (Ui.MainViewModel Ui, List<string> Folders, List<string> Excludes) КликамиПоДереву(Rnd r, List<string> узлы)
    {
        var ui = new Ui.MainViewModel(new FakeApi());
        var верх = узлы.Where(p => !p.Contains('/')).ToList();
        List<string> Внутри(bool? include)
        {
            var отмеченные = ui.Marks.Values.Where(m => include == null || m.Include == include).Select(m => Paths.CiKey(m.Path) + "/").ToList();
            return узлы.Where(p => отмеченные.Any(m => Paths.CiKey(p).StartsWith(m, StringComparison.Ordinal))).ToList();
        }
        ui.ToggleCheck(r.Pick(верх.Count > 0 ? верх : узлы));
        for (var k = 0; k < 14; k++)
        {
            var бросок = r.Next();
            // Отдельно целимся внутрь уже снятого: «исключено, а внутри снова включено».
            var глубже = бросок < 0.4 ? Внутри(false) : бросок < 0.75 ? Внутри(null) : new List<string>();
            ui.ToggleCheck(r.Pick(глубже.Count > 0 ? глубже : узлы));
        }
        // Проход по одной цепочке сверху вниз: чередование «включено / исключено / снова
        // включено» гарантированно, а не по счастливой случайности.
        var цепочка = r.Pick(узлы).Split('/');
        for (var d = 1; d <= цепочка.Length; d++) ui.ToggleCheck(string.Join('/', цепочка, 0, d));
        var (folders, excludes) = ui.CollectSelection();
        return (ui, folders, excludes);
    }

    private static List<string> Узлы(Sides s) => AllPaths(s.Src).Concat(AllPaths(s.Dst)).Distinct(StringComparer.Ordinal).ToList();

    // Тринадцатый закон: раскладка индекса по веткам (подъём по пути) отдаёт ветке то же,
    // что поветочный перебор, - на ветках от кликов, с вложенными парами.
    [Fact]
    public async Task раскладка_индекса_по_веткам_совпадает_с_поветочным_разбором()
    {
        static string Shape(ScanResult s) => string.Join("|",
            string.Join(",", s.Files.Select(e => $"{Paths.CiKey(e.Path)}:{e.Size}").OrderBy(x => x, StringComparer.Ordinal)),
            string.Join(",", s.Dirs.Select(Paths.CiKey).OrderBy(x => x, StringComparer.Ordinal)),
            string.Join(",", s.Skipped.Select(Paths.CiKey).OrderBy(x => x, StringComparer.Ordinal)));
        var вложенных = 0;
        var всего = 0;
        for (var i = 1; i <= 30; i++)
        {
            var r = new Rnd(i * 7919 + 1013);
            using var s = new Sides();
            MakeDenseTree(r, s.Src);
            PerturbedCopy(r, s.Src, s.Dst);
            var узлы = Узлы(s);
            if (узлы.Count == 0) continue;

            var (_, folders, excludes) = КликамиПоДереву(r, узлы);
            if (folders.Count == 0) continue;
            всего++;
            if (folders.Any(a => folders.Any(b => a != b && Paths.CiKey(a).StartsWith(Paths.CiKey(b) + "/", StringComparison.Ordinal)))) вложенных++;

            foreach (var root in new[] { s.Src, s.Dst })
            {
                var idx = await IndexOfSide(root);
                var groups = Plan.GroupIndexByBranch(idx, folders, excludes);
                foreach (var folder in folders)
                {
                    var перебором = Plan.ScanFromIndex(idx, folder, excludes);
                    var раскладкой = groups.GetValueOrDefault(Paths.CiKey(folder)) ?? ScanResult.Empty();
                    Assert.True(Shape(раскладкой) == Shape(перебором), $"прогон {i}: ветка {folder} разошлась (исключения: {string.Join(",", excludes)})");
                }
            }
        }
        Assert.True(вложенных >= 5, $"вложенных пар веток всего {вложенных} из {всего} прогонов - генератор до случая не доходит");
    }

    // Восьмой закон: что показывает строка на экране (IsIncluded) - то и происходит
    // с файлом на диске, и ничего сверх того.
    [Fact]
    public async Task что_отмечено_на_экране_то_и_синхронизируется_и_ничего_сверх_того()
    {
        for (var i = 1; i <= 30; i++)
        {
            var r = new Rnd(i * 7919 + 313);
            using var s = new Sides();
            MakeDenseTree(r, s.Src);
            PerturbedCopy(r, s.Src, s.Dst);
            var узлы = Узлы(s);
            if (узлы.Count == 0) continue;

            var (ui, folders, excludes) = КликамиПоДереву(r, узлы);
            if (folders.Count == 0) continue;

            var доПрогона = Snap(s.Dst);
            var наИсточнике = Snap(s.Src);
            var plan = await Plan.BuildRunPlan(s.Src, s.Dst, folders, excludes, Scanner);
            var res = await FsOps.ApplyPlan(s.Src, s.Dst, plan, RmTrash);
            Assert.True(res.Failures.Count == 0, $"прогон {i}: ошибки на ровном месте: {string.Join(", ", res.Failures)}");
            var после = Snap(s.Dst);

            var нарушения = new List<string>();
            foreach (var (ключ, было) in наИсточнике)
            {
                if (было == "/") continue;
                var отмечен = ui.IsIncluded(ключ);
                после.TryGetValue(ключ, out var стало);
                доПрогона.TryGetValue(ключ, out var раньше);
                if (отмечен && стало != было) нарушения.Add($"{ключ}: отмечен на экране, но на приёмнике {стало}");
                if (!отмечен && стало != раньше) нарушения.Add($"{ключ}: не отмечен, а на приёмнике поменялся");
            }
            foreach (var (ключ, было) in доПрогона)
            {
                if (было == "/" || наИсточнике.ContainsKey(ключ)) continue;
                if (ui.IsIncluded(ключ)) continue; // отмечен и лишний - законно удалён
                после.TryGetValue(ключ, out var стало);
                if (стало != было) нарушения.Add($"{ключ}: не отмечен, а с приёмника пропал");
            }
            Assert.True(нарушения.Count == 0, $"прогон {i}: экран и диск разошлись (ветки: {string.Join(",", folders)}; исключения: {string.Join(",", excludes)}): {string.Join("; ", нарушения)}");
        }
    }

    // Сверка генератора с JS: тот же засев даёт те же первые числа, что и в Node.
    [Fact]
    public void генератор_тот_же_что_в_JS()
    {
        var r = new Rnd(7919);
        var got = Enumerable.Range(0, 5).Select(_ => r.Next().ToString("R", System.Globalization.CultureInfo.InvariantCulture)).ToList();
        var js = System.Text.Json.JsonSerializer.Deserialize<List<double>>(Fixtures.Read("rnd.json"))!
            .Select(x => x.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).ToList();
        Assert.Equal(js, got);
    }
}
