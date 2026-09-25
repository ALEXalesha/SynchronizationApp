using SyncGlass.Core;

namespace SyncGlass.Tests;

// Перенос test/sync.test.js.
public class SyncTests
{
    private static FileEntry F(string path, long size, double mtimeMs) => new(path, size, mtimeMs);
    private static string[] Paths(IEnumerable<FileEntry> list) => list.Select(e => e.Path).ToArray();

    [Fact]
    public void файл_только_в_источнике_копировать()
    {
        var plan = Sync.PlanSync([F("a.txt", 10, 1000)], []);
        Assert.Single(plan.Copy);
        Assert.Equal("a.txt", plan.Copy[0].Path);
        Assert.Empty(plan.Overwrite);
        Assert.Empty(plan.Trash);
    }

    [Fact]
    public void файл_только_в_приёмнике_в_Корзину()
    {
        var plan = Sync.PlanSync([], [F("old.txt", 5, 500)]);
        Assert.Single(plan.Trash);
        Assert.Equal("old.txt", plan.Trash[0].Path);
        Assert.Empty(plan.Copy);
    }

    [Fact]
    public void одинаковые_файлы_без_изменений()
    {
        var plan = Sync.PlanSync([F("a.txt", 10, 1000)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Unchanged);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Overwrite);
        Assert.Empty(plan.Trash);
    }

    [Fact]
    public void разный_размер_перезаписать()
    {
        var plan = Sync.PlanSync([F("a.txt", 20, 1000)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Overwrite);
    }

    [Fact]
    public void разный_mtime_сверх_порога_перезаписать()
    {
        var plan = Sync.PlanSync([F("a.txt", 10, 10000)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Overwrite);
    }

    [Fact]
    public void mtime_в_пределах_порога_без_изменений()
    {
        var plan = Sync.PlanSync([F("a.txt", 10, 2500)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Unchanged);
        Assert.Empty(plan.Overwrite);
    }

    // Нового в C#: граница допуска. Ровно 2000 мс - ещё «одинаково», как у JS (>).
    [Fact]
    public void mtime_ровно_на_пороге_без_изменений()
    {
        var plan = Sync.PlanSync([F("a.txt", 10, 3000)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Unchanged);
        plan = Sync.PlanSync([F("a.txt", 10, 3000.5)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Overwrite);
    }

    [Fact]
    public void вложенные_пути_обрабатываются_по_полному_пути()
    {
        var plan = Sync.PlanSync(
            [F("sub/a.txt", 10, 1000), F("sub/b.txt", 5, 900)],
            [F("sub/a.txt", 10, 1000), F("sub/c.txt", 7, 800)]);
        Assert.Equal(["sub/b.txt"], Paths(plan.Copy));
        Assert.Equal(["sub/c.txt"], Paths(plan.Trash));
        Assert.Equal(["sub/a.txt"], Paths(plan.Unchanged));
    }

    [Fact]
    public void summarize_считает_итоги_и_total()
    {
        var plan = Sync.PlanSync(
            [F("a", 1, 1), F("b", 2, 1), F("c", 3, 1)],
            [F("a", 9, 1), F("x", 1, 1)]);
        // a перезаписать, b и c копировать, x в корзину
        var s = Sync.Summarize(plan);
        Assert.Equal(2, s.Copy);
        Assert.Equal(1, s.Overwrite);
        Assert.Equal(1, s.Trash);
        Assert.Equal(4, s.Total);
    }

    [Fact]
    public void isChanged_одинаковый_размер_и_время_false()
    {
        Assert.False(Sync.IsChanged(F("a", 10, 1000), F("a", 10, 1000)));
    }

    // На шаре дата после копирования отличается на доли секунды. Раньше это ломало
    // сопоставление, и перенос выглядел как удалить + скопировать заново.
    [Fact]
    public void перемещение_находится_даже_если_приёмник_округлил_дату()
    {
        var plan = Sync.DetectMoves(Sync.PlanSync(
            [F("Архив/скан.pdf", 100500, 1700000000000)],
            [F("Входящие/скан.pdf", 100500, 1700000001300)]));
        Assert.Single(plan.Moves);
        Assert.Equal("Входящие/скан.pdf", plan.Moves[0].From);
        Assert.Equal("Архив/скан.pdf", plan.Moves[0].To);
    }

    [Fact]
    public void одинаковое_имя_и_размер_но_дата_разошлась_сильно_это_разные_файлы()
    {
        var plan = Sync.DetectMoves(Sync.PlanSync(
            [F("Новая/док.txt", 50, 1700000000000)],
            [F("Старая/док.txt", 50, 1600000000000)]));
        Assert.Empty(plan.Moves);
        Assert.Single(plan.Copy);
        Assert.Single(plan.Trash);
    }

    // Нового в C#: пара признаётся, только когда кандидат один с каждой стороны.
    [Fact]
    public void два_одинаковых_кандидата_не_сводятся_в_перемещение()
    {
        var plan = Sync.DetectMoves(Sync.PlanSync(
            [F("n1/a.txt", 5, 1000), F("n2/a.txt", 5, 1000)],
            [F("o/a.txt", 5, 1000)]));
        Assert.Empty(plan.Moves);
        Assert.Equal(2, plan.Copy.Count);
        Assert.Single(plan.Trash);
    }

    [Fact]
    public void planDirs_удаляет_от_глубоких_к_мелким_создаёт_от_мелких_к_глубоким()
    {
        var dirs = Sync.PlanDirs(["a", "a/b", "a/b/c"], ["x", "x/y"]);
        Assert.Equal(["a", "a/b", "a/b/c"], dirs.Create);
        Assert.Equal(["x/y", "x"], dirs.Remove);
    }

    [Fact]
    public void summarize_учитывает_перемещения_и_папки_в_total()
    {
        var plan = Sync.DetectMoves(Sync.PlanSync([F("n/a.txt", 1, 1)], [F("o/a.txt", 1, 1)]));
        plan.Dirs = new DirPlan { Create = ["n"], Remove = ["o"] };
        var s = Sync.Summarize(plan);
        Assert.Equal(1, s.Move);
        Assert.Equal(0, s.Copy);
        Assert.Equal(2, s.Dirs);
        Assert.Equal(3, s.Total);
    }

    // ---- Регистр в путях ----
    // NTFS и сетевые шары не различают 'Note.txt' и 'note.txt'. Пока сравнение шло
    // точно, один файл выглядел двумя: копия ложилась поверх приёмника, а следом
    // исходное написание удалялось - и файл пропадал с приёмника совсем.

    [Fact]
    public void путь_отличается_только_регистром_это_один_файл()
    {
        var plan = Sync.PlanSync([F("док/Заметка.txt", 10, 1000)], [F("док/заметка.txt", 10, 1000)]);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Trash);
        // Перезапись, а не «без изменений»: она начинается с переноса оригинала
        // в служебную папку, поэтому на месте остаётся написание источника.
        Assert.Single(plan.Overwrite);
        Assert.Equal("док/Заметка.txt", plan.Overwrite[0].Path);
    }

    // Написание папки-предка так не чинится: папку никто не переименовывает,
    // и файл уходил бы в перезапись на каждом запуске - вечный круг.
    [Fact]
    public void разный_регистр_у_папки_предка_не_повод_перезаписывать_файл()
    {
        var plan = Sync.PlanSync([F("док/a0/n.txt", 10, 1000)], [F("док/A0/n.txt", 10, 1000)]);
        Assert.Empty(plan.Overwrite);
        Assert.Single(plan.Unchanged);
        Assert.Empty(plan.Copy);
        Assert.Empty(plan.Trash);
    }

    [Fact]
    public void разный_регистр_у_имени_файла_внутри_такой_папки_всё_равно_перезапись()
    {
        var plan = Sync.PlanSync([F("док/a0/Note.txt", 10, 1000)], [F("док/A0/note.txt", 10, 1000)]);
        Assert.Single(plan.Overwrite);
        Assert.Equal("док/a0/Note.txt", plan.Overwrite[0].Path);
    }

    [Fact]
    public void одинаковое_написание_и_содержимое_по_прежнему_без_изменений()
    {
        var plan = Sync.PlanSync([F("a.txt", 10, 1000)], [F("a.txt", 10, 1000)]);
        Assert.Single(plan.Unchanged);
        Assert.Empty(plan.Overwrite);
    }

    [Fact]
    public void planDirs_не_сносит_папку_приёмника_написанную_в_другом_регистре()
    {
        var r = Sync.PlanDirs(["Док", "Док/год"], ["док", "док/год", "лишняя"]);
        Assert.Empty(r.Create);
        Assert.Equal(["лишняя"], r.Remove);
    }

    // Одна и та же папка приходит из разных выбранных веток, и стороны могут писать
    // её имя по-разному: mkdir уходил дважды, откат сносил одну папку два раза.
    [Fact]
    public void planDirs_не_создаёт_одну_папку_дважды_из_за_разного_написания()
    {
        var r = Sync.PlanDirs(["Отчёты", "отчёты", "Отчёты/2024"], []);
        Assert.Equal(["Отчёты", "Отчёты/2024"], r.Create);
    }

    [Fact]
    public void planDirs_не_удаляет_одну_лишнюю_папку_дважды()
    {
        var r = Sync.PlanDirs([], ["Старое", "старое"]);
        Assert.Equal(["Старое"], r.Remove);
    }

    // Нового в C#: зеркальный случай - заглавное написание на приёмнике. В тесте выше
    // приёмник пишет строчными, и сравнение без ключа на этой стороне проходило.
    [Fact]
    public void planDirs_не_создаёт_папку_которая_на_приёмнике_в_другом_регистре()
    {
        var r = Sync.PlanDirs(["док", "док/год"], ["Док", "ДОК/Год"]);
        Assert.Empty(r.Create);
        Assert.Empty(r.Remove);
    }

    // Нового в C#: конфликт типа убирает узел с приёмника - в сводке это удаление.
    [Fact]
    public void summarize_считает_конфликты_удалением()
    {
        var plan = new SyncPlan { Conflicts = ["Отчёты"] };
        plan.Trash.Add(F("x.txt", 1, 1));
        var s = Sync.Summarize(plan);
        Assert.Equal(2, s.Trash);
        Assert.Equal(2, s.Total);
    }

    // Нового в C#: сортировка папок - по кодам UTF-16, как Array.sort в JS, а не
    // по правилам языка. Иначе порядок создания зависел бы от локали ПК.
    [Fact]
    public void planDirs_сортирует_как_JS_по_кодам_символов()
    {
        var r = Sync.PlanDirs(["b", "B", "a-b", "a_b", "ä", "Z"], []);
        // Сверено с Node: ["Z","a-b","a_b","b","ä"] ('B' - повтор 'b' без учёта регистра).
        Assert.Equal(["Z", "a-b", "a_b", "b", "ä"], r.Create);
    }
}
