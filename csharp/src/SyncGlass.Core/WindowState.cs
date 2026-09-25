using System.Text.Json.Nodes;

namespace SyncGlass.Core;

/// <summary>
/// Перенос src/window-state.js: место окна между запусками. Тот же модуль, что в
/// калькуляторах и Paint Pro; у SyncGlass окно постоянного размера, так что по сути
/// запоминается место. Файл window-state.json общий с Electron-версией:
/// {x, y, width, height, maximized}.
///
/// Что может прийти из файла: окно на отключённом мониторе, размер больше экрана или
/// меньше минимума, мусор вместо чисел, пустой или обрезанный файл. Всё это должно
/// давать окно, которое видно и за которое можно взяться, а не падение.
/// </summary>
public static class WindowState
{
    // Сколько окна должно оставаться на экране, чтобы за него можно было взяться: полоса
    // заголовка высотой 38 (системный заголовок Windows с запасом) и хотя бы 80 по ширине.
    public const double GripHeight = 38;
    public const double GripWidth = 80;

    public readonly record struct Area(double X, double Y, double Width, double Height);

    // Что лежало в файле: любое поле может оказаться не числом - тогда null.
    public sealed record Saved(double? X, double? Y, double? Width, double? Height, bool Maximized);

    // Где и какого размера открыть окно; X и Y = null - поставить по центру.
    public sealed record Placement(double? X, double? Y, double Width, double Height, bool Maximized);

    public sealed record Options(double Width, double Height, double MinWidth, double MinHeight);

    private static bool Finite(double? v) => v is { } d && double.IsFinite(d);

    public static Placement Restore(Saved? saved, IEnumerable<Area> areas, Options opts)
    {
        var byDefault = new Placement(null, null, opts.Width, opts.Height, false);
        var screens = areas.Where(a => double.IsFinite(a.X) && double.IsFinite(a.Y) && double.IsFinite(a.Width)
                                       && double.IsFinite(a.Height) && a.Width > 0 && a.Height > 0).ToList();
        if (saved == null || !Finite(saved.Width) || !Finite(saved.Height)) return byDefault;

        var maximized = saved.Maximized;
        // Самый большой экран ограничивает размер сверху.
        var bw = screens.Aggregate(opts.Width, (m, a) => Math.Max(m, a.Width));
        var bh = screens.Aggregate(opts.Height, (m, a) => Math.Max(m, a.Height));
        var width = JsRound(Math.Min(Math.Max(saved.Width!.Value, opts.MinWidth), Math.Max(bw, opts.MinWidth)));
        var height = JsRound(Math.Min(Math.Max(saved.Height!.Value, opts.MinHeight), Math.Max(bh, opts.MinHeight)));

        if (!Finite(saved.X) || !Finite(saved.Y)) return new Placement(null, null, width, height, maximized);
        var x = JsRound(saved.X!.Value);
        var y = JsRound(saved.Y!.Value);

        // Экран, на котором больше всего полосы заголовка. Не видна ни на одном - по центру.
        Area? best = null;
        double bestArea = 0;
        foreach (var a in screens)
        {
            var ow = Math.Min(x + width, a.X + a.Width) - Math.Max(x, a.X);
            var oh = Math.Min(y + GripHeight, a.Y + a.Height) - Math.Max(y, a.Y);
            if (ow > 0 && oh > 0 && ow * oh > bestArea)
            {
                best = a;
                bestArea = ow * oh;
            }
        }
        if (best is not { } b || bestArea < GripWidth * GripHeight / 2) return new Placement(null, null, width, height, maximized);

        // Съехавшее окно придвигается к краю своего экрана целиком; выше экрана - верхом:
        // заголовок важнее низа.
        width = Math.Min(width, Math.Max(b.Width, opts.MinWidth));
        height = Math.Min(height, Math.Max(b.Height, opts.MinHeight));
        var nx = Math.Max(b.X, Math.Min(x, b.X + b.Width - width));
        var ny = Math.Max(b.Y, Math.Min(y, b.Y + b.Height - height));
        return new Placement(nx, ny, width, height, maximized);
    }

    // Math.round из JS: половина - вверх (к +∞), а не к чётному, как Math.Round.
    private static double JsRound(double v) => Math.Floor(v + 0.5);

    // Прочитать файл; нет файла или в нём не объект - null. Поле не числом - null.
    public static Saved? Load(string file)
    {
        try
        {
            if (JsonNode.Parse(File.ReadAllText(file)) is not JsonObject o) return null;
            static double? Num(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;
            var max = o["maximized"] is JsonValue m && m.TryGetValue<bool>(out var bm) && bm;
            return new Saved(Num(o["x"]), Num(o["y"]), Num(o["width"]), Num(o["height"]), max);
        }
        catch
        {
            return null;
        }
    }

    // Записать через временный файл: убьют на середине - останется старый, а не обрезанный.
    public static bool Save(string file, Placement p)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var tmp = file + ".tmp";
            var o = new JsonObject();
            if (p.X is { } x) o["x"] = x;
            if (p.Y is { } y) o["y"] = y;
            o["width"] = p.Width;
            o["height"] = p.Height;
            o["maximized"] = p.Maximized;
            File.WriteAllText(tmp, o.ToJsonString());
            FsOps.Rename(tmp, file);
            return true;
        }
        catch
        {
            return false; // не записалось - в следующий раз окно откроется по умолчанию
        }
    }
}
