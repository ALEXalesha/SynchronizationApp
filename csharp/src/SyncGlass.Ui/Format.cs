using System.Globalization;

namespace SyncGlass.Ui;

/// <summary>Утилиты вывода из renderer.js: размеры, числа с разрядами, даты.</summary>
public static class Format
{
    private static readonly CultureInfo Ru = CultureInfo.GetCultureInfo("ru-RU");
    private static readonly string[] Units = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];

    // Без ограничения сверху шкала кончалась бы раньше числа («2 undefined» у JS).
    // Дробная часть - с точкой, как toFixed.
    public static string FormatSize(long? bytes)
    {
        if (bytes is not { } b) return "";
        if (b == 0) return "0 Б";
        var i = Math.Min(Units.Length - 1, (int)Math.Floor(Math.Log(b) / Math.Log(1024)));
        var v = b / Math.Pow(1024, i);
        return v.ToString(v < 10 && i > 0 ? "F1" : "F0", CultureInfo.InvariantCulture) + " " + Units[i];
    }

    // Разряды как у toLocaleString('ru-RU'): неразрывный пробел.
    public static string FmtNum(long n) => n.ToString("N0", Ru);

    // Счётчик в плашке предпросмотра: плашка узкая, четыре в ряд, а число бывает
    // шестизначным - шрифт мельчает по длине записи (классы как в styles.css).
    public static string NumSize(string text) => text.Length switch
    {
        > 11 => "num-xs",
        > 7 => "num-s",
        > 5 => "num-m",
        _ => "",
    };

    // Дата записи истории: как new Date(iso).toLocaleString('ru-RU').
    public static string FmtDateTime(string? iso)
    {
        if (iso != null && DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t))
            return t.ToLocalTime().ToString("dd.MM.yyyy, HH:mm:ss", CultureInfo.InvariantCulture);
        return iso ?? "";
    }
}
