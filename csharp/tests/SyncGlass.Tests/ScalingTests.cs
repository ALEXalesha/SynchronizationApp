using System.Diagnostics;
using SyncGlass.Core;
using SyncGlass.Core.Main;

namespace SyncGlass.Tests;

// Перенос test/scaling.test.js - закон масштаба: сеть на класс дефектов, а не замер
// на одно найденное место. Растёт ОДНО измерение входа (исключения), остальные стоят:
// линейная работа не меняется, и любое произведение с этим измерением вылезает само.
// Обе дороги (живой скан и индекс обхода) - под одним законом: разошлись они уже
// дважды, когда правку делали только на одной.
//
// ЧЕГО ЭТОТ ЗАКОН НЕ СПРАШИВАЕТ - то же, что в JS: «ветки × размер индекса» без
// исключений осью веток не разделить (здоровый ×3 против сломанного ×3.6).
[Collection("Законы масштаба")] // секундомер не делит машину с другими тестами
public class ScalingTests
{
    private const int Веток = 400;
    private const int ФайловНаВетку = 2;
    private const int Исключений = 5000;
    private const int K = 4;

    private static async Task<(long Мс, int Худший)> Прогон(int исключений, bool сОбходом)
    {
        using var userData = new TempDir();
        using var src = new TempDir();
        using var dst = new TempDir();
        var b = new Backend(userData.Root);
        var folders = new List<string>();
        for (var i = 0; i < Веток; i++)
        {
            // Общий предок у всех веток намеренный: его тип спрашивали заново на каждую ветку.
            var rel = $"год/квартал{i % 4}/ветка{i}";
            folders.Add(rel);
            for (var j = 0; j < ФайловНаВетку; j++) src.Write($"{rel}/ф{j}.txt", "x");
        }
        dst.Mkdir("год");

        // Исключения на несуществующие пути: работы от них не прибавляется.
        var excludes = Enumerable.Range(0, исключений).Select(i => $"{folders[i % Веток]}/нет{i}").ToList();

        if (сОбходом) await b.StartCrawl(src.Root, dst.Root, true, new RecordingSink());

        var сколькоРаз = new Dictionary<string, int>(StringComparer.Ordinal);
        FsOps.DiskObserver.Value = p =>
        {
            lock (сколькоРаз) сколькоРаз[p] = сколькоРаз.GetValueOrDefault(p) + 1;
        };
        var sw = Stopwatch.StartNew();
        PreviewResult res;
        try
        {
            res = await b.Preview(new SyncArgs(src.Root, dst.Root, folders, excludes, "toNetwork"));
        }
        finally
        {
            FsOps.DiskObserver.Value = null;
        }
        sw.Stop();

        Assert.True(res.Error == null, $"предпросмотр не отработал: {res.Error}");
        Assert.Equal(Веток * ФайловНаВетку, res.Totals!.Copy);
        return (sw.ElapsedMilliseconds, сколькоРаз.Values.DefaultIfEmpty(0).Max());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task предпросмотр_вчетверо_больше_исключений_та_же_цена(bool сОбходом)
    {
        await Прогон(Исключений, сОбходом); // прогрев: JIT и кеши системы - не часть закона
        var мал = await Прогон(Исключений, сОбходом);
        var бол = await Прогон(Исключений * K, сОбходом);

        var рост = бол.Мс / (double)Math.Max(мал.Мс, 1);
        var дорога = сОбходом ? "по индексу обхода" : "живым сканом";
        Assert.True(рост < 2, $"{дорога}: исключений вчетверо больше, а цена выросла в {рост:F1} раз ({мал.Мс} → {бол.Мс} мс): похоже на перебор исключений внутри перебора веток");

        // Повторное чтение одного узла на каждую ветку растёт линейно - осью его не поймать,
        // а на сетевой шаре оно дороже всего. Двойка, а не единица: корни сторон
        // проверяются на достижимость отдельно от разбора веток.
        foreach (var (_, худший) in new[] { мал, бол })
            Assert.True(худший <= 2, $"{дорога}: один и тот же путь спрошен у диска {худший} раз за предпросмотр");
    }
}

[CollectionDefinition("Законы масштаба", DisableParallelization = true)]
public class ScalingCollection;
