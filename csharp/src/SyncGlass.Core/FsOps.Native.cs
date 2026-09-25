using System.ComponentModel;
using System.Runtime.InteropServices;

namespace SyncGlass.Core;

// Ошибка файловой системы с кодом в духе Node (ENOENT, EPERM, EBUSY...): коды уходят
// в отчёт о сбоях и в историю, и в обеих версиях должны читаться одинаково.
public sealed class FsException : IOException
{
    public string Code { get; }
    public FsException(string code, string message) : base(message) => Code = code;
}

public static partial class FsOps
{
    // Код ошибки для отчёта: как err.code в Node, иначе текст.
    public static string ErrCode(Exception e) => e switch
    {
        FsException f => f.Code,
        FileNotFoundException or DirectoryNotFoundException => "ENOENT",
        UnauthorizedAccessException => "EPERM",
        IOException io => (io.HResult & 0xFFFF) switch
        {
            32 or 33 => "EBUSY",          // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
            80 or 183 => "EEXIST",        // ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS
            145 => "ENOTEMPTY",           // ERROR_DIR_NOT_EMPTY
            267 => "ENOTDIR",             // ERROR_DIRECTORY
            206 => "ENAMETOOLONG",        // ERROR_FILENAME_EXCED_RANGE
            _ => io.Message,
        },
        _ => e.Message,
    };

    internal static bool IsGone(Exception e) => e is FileNotFoundException or DirectoryNotFoundException
        || (e is FsException f && f.Code == "ENOENT");

    internal static bool IsDenied(Exception e) => e is UnauthorizedAccessException
        || (e is FsException f && (f.Code == "EPERM" || f.Code == "EACCES"));

    private static string CodeOf(int win32) => win32 switch
    {
        2 or 3 => "ENOENT",
        5 => "EPERM",
        32 or 33 => "EBUSY",
        80 or 183 => "EEXIST",
        145 => "ENOTEMPTY",
        267 => "ENOTDIR",
        206 => "ENAMETOOLONG",
        _ => "E" + win32,
    };

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existing, string replacement, int flags);

    private const int MOVEFILE_REPLACE_EXISTING = 0x1;

    // Переименование ровно как fsp.rename в Node на Windows: libuv зовёт MoveFileExW
    // с REPLACE_EXISTING, и откат со служебной папкой держится на этих правилах:
    // файл поверх файла - замена, папка поверх файла - замена, что угодно поверх
    // папки - отказ. File.Move/Directory.Move ведут себя иначе, поэтому напрямую.
    public static void Rename(string from, string to)
    {
        if (!MoveFileEx(Long(from), Long(to), MOVEFILE_REPLACE_EXISTING))
        {
            var err = Marshal.GetLastWin32Error();
            throw new FsException(CodeOf(err), $"{new Win32Exception(err).Message}: rename '{from}' -> '{to}'");
        }
    }

    // Длинный путь (> 260) без префикса \\?\ системный вызов не примет.
    private static string Long(string p)
    {
        var full = Path.GetFullPath(p);
        if (full.Length < 248 || full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
        return full.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + full[2..] : @"\\?\" + full;
    }
}
