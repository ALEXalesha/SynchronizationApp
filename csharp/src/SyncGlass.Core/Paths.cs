namespace SyncGlass.Core;

/// <summary>Перенос src/paths.js.</summary>
public static class Paths
{
    // Ключ для сравнения путей двух сторон. Регистр не значим: NTFS и сетевые шары
    // не различают 'Docs' и 'docs', поэтому точное сравнение выдавало один и тот же
    // файл за два разных - приёмник получал копию поверх своего же файла, а следом
    // исходное имя удалялось (подробно - src/paths.js). Инвариантный регистр,
    // а не текущий язык: локаль пользователя не должна влиять на то, совпали пути
    // или нет. Совпадение с JS до символа держит ContractTests по образцу из Node.
    //
    // ToLowerInvariant - простое посимвольное отображение, а toLowerCase в JS - полное,
    // по SpecialCasing Unicode. Разница в двух местах, и обе дописаны ниже: 'İ' JS
    // превращает в 'i' с точкой сверху (две буквы), а заглавная сигма в конце слова
    // становится 'ς'. Без этого одна и та же папка 'ΟΔΟΣ' давала в двух версиях
    // разные ключи, и общий кеш размеров не находил своих строк.
    public static string CiKey(string p)
    {
        var lower = p.ToLowerInvariant();
        if (p.IndexOf('\u0130') < 0 && p.IndexOf('\u03A3') < 0) return lower;
        // Простое отображение не меняет длину, поэтому позиции в p и lower совпадают.
        var sb = new System.Text.StringBuilder(lower.Length + 4);
        for (var i = 0; i < p.Length; i++)
        {
            if (p[i] == '\u0130') sb.Append("i\u0307");
            else if (p[i] == '\u03A3') sb.Append(IsFinalSigma(p, i) ? '\u03C2' : '\u03C3');
            else sb.Append(lower[i]);
        }
        return sb.ToString();
    }

    // Final_Sigma из Unicode: перед сигмой буква с регистром (знаки без регистра между
    // ними пропускаются), а после неё такой буквы нет.
    private static bool IsFinalSigma(string s, int at)
    {
        var before = false;
        for (var i = at - 1; i >= 0; i--)
        {
            if (char.IsLowSurrogate(s[i]) && i > 0 && char.IsHighSurrogate(s[i - 1])) i--;
            if (IsCaseIgnorable(s, i)) continue;
            before = IsCased(s, i);
            break;
        }
        if (!before) return false;
        for (var i = at + 1; i < s.Length; i += char.IsSurrogatePair(s, i) ? 2 : 1)
        {
            if (IsCaseIgnorable(s, i)) continue;
            return !IsCased(s, i);
        }
        return true;
    }

    private static bool IsCased(string s, int i)
    {
        var cat = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(s, i);
        if (cat is System.Globalization.UnicodeCategory.UppercaseLetter
            or System.Globalization.UnicodeCategory.LowercaseLetter
            or System.Globalization.UnicodeCategory.TitlecaseLetter) return true;
        // Other_Uppercase / Other_Lowercase: римские цифры, буквы в кружках - у них
        // есть пара другого регистра, хотя буквами они не числятся.
        var one = char.IsSurrogatePair(s, i) ? s.Substring(i, 2) : s[i].ToString();
        return one.ToLowerInvariant() != one || one.ToUpperInvariant() != one;
    }

    private static bool IsCaseIgnorable(string s, int i)
    {
        var cat = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(s, i);
        if (cat is System.Globalization.UnicodeCategory.NonSpacingMark
            or System.Globalization.UnicodeCategory.EnclosingMark
            or System.Globalization.UnicodeCategory.Format
            or System.Globalization.UnicodeCategory.ModifierLetter
            or System.Globalization.UnicodeCategory.ModifierSymbol) return true;
        // Word_Break MidLetter / MidNumLet / Single_Quote.
        return s[i] is '\'' or '.' or ':' or '\u00B7' or '\u0387' or '\u05F4' or '\u2018'
            or '\u2019' or '\u2024' or '\u2027' or '\uFE13' or '\uFE52' or '\uFE55'
            or '\uFF07' or '\uFF0E' or '\uFF1A';
    }

    // Лежит ли inner внутри outer (или это тот же путь).
    // Регистр не важен: на Windows пути к нему нечувствительны.
    public static bool IsInside(string inner, string outer)
    {
        var a = Resolve(inner).ToLowerInvariant();
        var b = Resolve(outer).ToLowerInvariant();
        var sep = Path.DirectorySeparatorChar.ToString();
        return a == b || a.StartsWith(b.EndsWith(sep) ? b : b + sep, StringComparison.Ordinal);
    }

    // Пересекаются ли корни синхронизации: один внутри другого или это одна папка.
    // Такая пара - копирование папки внутрь самой себя: приёмник по ходу работы
    // растёт, и уже скопированное снова выглядит новым.
    public static bool RootsOverlap(string srcRoot, string dstRoot)
        => IsInside(srcRoot, dstRoot) || IsInside(dstRoot, srcRoot);

    // Как path.resolve: полный путь без хвостового разделителя (кроме корня диска).
    private static string Resolve(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
}
