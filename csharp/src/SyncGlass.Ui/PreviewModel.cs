using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using SyncGlass.Core;
using SyncGlass.Core.Main;

namespace SyncGlass.Ui;

/// <summary>
/// Окно предпросмотра и запуска (openPreview, renderPreview, runSync в renderer.js).
/// Слой поверх главного окна, как модальный слой в Electron.
/// </summary>
public sealed partial class PreviewModel(MainViewModel main) : ObservableObject
{
    // Сколько строк веток рисуем. Сверх предела - только ветки с работой, остальные числом:
    // «Выбрать все» на папке с десятками тысяч узлов давал десятки тысяч строк.
    public const int PreviewRows = 500;

    [ObservableProperty] private bool _isOpen;
    [ObservableProperty] private string _title = "Предпросмотр синхронизации";

    public StatItem Move { get; } = new("move", "переместить");
    public StatItem Copy { get; } = new("copy", "скопировать");
    public StatItem Overwrite { get; } = new("overwrite", "перезаписать");
    public StatItem Trash { get; } = new("trash", "удалить");
    [ObservableProperty] private bool _statsVisible;
    [ObservableProperty] private bool _moveVisible;

    public ObservableCollection<Notice> Notices { get; } = new();
    public ObservableCollection<PreviewRow> Rows { get; } = new();

    [ObservableProperty] private bool _progressVisible;
    [ObservableProperty] private bool _progressIndeterminate;
    [ObservableProperty] private double _progressPercent;
    [ObservableProperty] private string _progressText = "";

    [ObservableProperty] private string _cancelText = "Отмена";
    [ObservableProperty] private bool _cancelEnabled = true;
    [ObservableProperty] private string _confirmText = "Выполнить";
    [ObservableProperty] private bool _confirmEnabled;

    private string _confirmMode = "run"; // run | close
    private bool _syncRunning;
    private Summary _lastTotals = new(0, 0, 0, 0, 0, 0, 0);

    private void Message(string kind, string text)
    {
        StatsVisible = false;
        Notices.Clear();
        Notices.Add(new Notice(kind, text));
    }

    public async Task Open()
    {
        var (folders, _) = main.CollectSelection();
        if (folders.Count == 0) return;

        Title = "Предпросмотр синхронизации";
        Message("empty", "Сканирую выбранное…");
        Rows.Clear();
        ProgressText = ""; // сброс прошлого «Готово …»
        ProgressPercent = 0;
        ConfirmEnabled = false;
        ConfirmText = "Выполнить";
        CancelEnabled = true;
        _confirmMode = "run";
        IsOpen = true;
        // Общее число файлов заранее неизвестно - «бегущая» полоска активности.
        ProgressVisible = true;
        ProgressIndeterminate = true;

        var progress = new Progress<int>(scanned => Message("empty", $"Сканирую выбранное… {Format.FmtNum(scanned)} файлов"));
        PreviewResult result;
        try
        {
            result = await main.Api.Preview(main.Args(), progress);
        }
        catch (Exception err)
        {
            result = new PreviewResult(Error: err.Message);
        }
        finally
        {
            ProgressIndeterminate = false;
            ProgressVisible = false;
            ProgressPercent = 0;
        }

        if (result.Aborted) return; // окно уже закрыто отменой
        if (result.Error != null)
        {
            Message("empty", $"Не удалось просканировать: {result.Error}.\nПроверьте связь с сетевой папкой и повторите.");
            Rows.Clear();
            ConfirmEnabled = false;
            return;
        }
        Render(result);
        ConfirmEnabled = result.Totals!.Total > 0;
    }

    public void Render(PreviewResult r)
    {
        var totals = r.Totals!;
        _lastTotals = totals;
        Notices.Clear();
        StatsVisible = true;
        // Перемещения - только когда они есть: в обычном прогоне их ноль.
        MoveVisible = totals.Move > 0;
        Move.Set(totals.Move);
        Copy.Set(totals.Copy);
        Overwrite.Set(totals.Overwrite);
        Trash.Set(totals.Trash);
        if (totals.Dirs > 0) Notices.Add(new Notice("note", $"Папок привести в порядок: {totals.Dirs}"));
        // Корзины нет ни на одной стороне - предупреждение всегда, когда есть что удалять.
        if (totals.Trash > 0)
            Notices.Add(new Notice("warn", "⚠ Лишние файлы удаляются безвозвратно, мимо Корзины. Вернуть их можно только до конца работы — кнопкой «Остановить»."));
        // Закрытые правами: сравнить не с чем - сказать об этом надо до запуска.
        if (r.SkippedTotal > 0)
        {
            var list = string.Join("\n", r.Skipped ?? []);
            var more = r.SkippedTotal > (r.Skipped?.Count ?? 0) ? "\n…" : "";
            Notices.Add(new Notice("warn", $"⚠ Нет доступа к {r.SkippedTotal} папкам и файлам — они не тронуты ни на одной стороне:\n{list}{more}"));
        }

        var dirLabel = main.Direction == "toNetwork" ? "Локально → Сеть" : "Сеть → Локально";
        var perFolder = r.PerFolder ?? new List<FolderCount>();
        Rows.Clear();
        Rows.Add(new PreviewRow(dirLabel, "", IsHead: true));
        if (perFolder.Count <= PreviewRows)
        {
            foreach (var pf in perFolder) Rows.Add(Row(pf));
        }
        else
        {
            var busy = perFolder.Where(pf => pf.Summary.Total > 0).ToList();
            foreach (var pf in busy.Take(PreviewRows)) Rows.Add(Row(pf));
            var tail = new List<string>();
            if (busy.Count > PreviewRows) tail.Add($"…ещё {Format.FmtNum(busy.Count - PreviewRows)} с работой");
            var idle = perFolder.Count - busy.Count;
            if (idle > 0) tail.Add($"{Format.FmtNum(idle)} без изменений");
            if (tail.Count > 0) Rows.Add(new PreviewRow(string.Join(", ", tail), "", IsMore: true));
        }
    }

    private static PreviewRow Row(FolderCount pf)
    {
        var s = pf.Summary;
        var parts = new List<string>();
        if (s.Move > 0) parts.Add($"→{Format.FmtNum(s.Move)}");
        if (s.Copy > 0) parts.Add($"+{Format.FmtNum(s.Copy)}");
        if (s.Overwrite > 0) parts.Add($"~{Format.FmtNum(s.Overwrite)}");
        if (s.Trash > 0) parts.Add($"−{Format.FmtNum(s.Trash)}");
        return new PreviewRow(pf.Folder, parts.Count > 0 ? string.Join("  ", parts) : "без изменений");
    }

    // Во время работы левая кнопка - «Остановить»: работа прекращается и откатывается.
    public async Task Cancel()
    {
        if (_syncRunning)
        {
            CancelEnabled = false;
            CancelText = "Останавливаю…";
            ProgressText = "Останавливаю и возвращаю всё как было…";
            ProgressIndeterminate = true;
            main.Api.CancelSync();
            return;
        }
        main.Api.CancelPreview(); // остановить идущий скан, если он есть
        IsOpen = false;
        if (_confirmMode == "close")
        {
            // Синхронизация уже прошла - список на экране устарел.
            _confirmMode = "run";
            await main.Refresh(true);
        }
    }

    public async Task Confirm()
    {
        if (_confirmMode == "close")
        {
            IsOpen = false;
            _confirmMode = "run";
            CancelEnabled = true;
            await main.Refresh(true);
        }
        else await RunSync();
    }

    private static readonly Dictionary<string, string> ActionVerb = new()
    {
        ["move"] = "перемещаю",
        ["copy"] = "копирую",
        ["overwrite"] = "обновляю",
        ["trash"] = "убираю",
        ["mkdir"] = "создаю папку",
        ["rmdir"] = "убираю папку",
        ["rollback"] = "возвращаю как было",
    };

    public async Task RunSync()
    {
        _syncRunning = true;
        ConfirmEnabled = false;
        CancelEnabled = true;
        CancelText = "Остановить";
        ProgressVisible = true;
        ProgressIndeterminate = false;
        ProgressPercent = 0;
        ProgressText = "Начинаю…";

        // Живой счётчик по действиям - цифры в плашках растут по ходу работы.
        var progress = new Progress<SyncProgress>(p =>
        {
            if (p.Action == "rollback") return; // текст уже показан кнопкой остановки
            ProgressPercent = p.Total > 0 ? Math.Round(p.Done * 100.0 / p.Total) : 100;
            ProgressText = $"{p.Done}/{p.Total} · {ActionVerb.GetValueOrDefault(p.Action, "")} {p.Path}";
            Move.Set(p.By.GetValueOrDefault("move"), _lastTotals.Move);
            Copy.Set(p.By.GetValueOrDefault("copy"), _lastTotals.Copy);
            Overwrite.Set(p.By.GetValueOrDefault("overwrite"), _lastTotals.Overwrite);
            Trash.Set(p.By.GetValueOrDefault("trash"), _lastTotals.Trash);
        });

        try
        {
            var res = await main.Api.Sync(main.Args(), progress);
            ProgressIndeterminate = false;
            if (res.Error != null && !res.Started)
            {
                // Отказались начинать - важно сказать прямо, что приёмник не тронут.
                ProgressPercent = 0;
                ProgressText = "Не начато";
                Message("warn", $"⚠ Синхронизация не начиналась: {res.Error}.\nНичего не изменено. Проверьте связь и повторите.");
            }
            else if (res.Error != null)
            {
                // Оборвалось уже на записи - обещать «ничего не изменено» нельзя.
                ProgressText = "Прервано ошибкой";
                Message("warn", $"⚠ Синхронизация оборвалась: {res.Error}.\nЧасть файлов могла быть обработана. Проверьте связь и запустите ещё раз — незавершённое будет разобрано на старте.");
            }
            else if (res.Cancelled)
            {
                ProgressPercent = 0;
                ProgressText = "Остановлено, всё возвращено как было";
                Message("note", "Синхронизация прервана. Скопированное удалено, перезаписанное и удалённое возвращено на место.");
                if (res.Unrecoverable > 0)
                    Notices.Add(new Notice("warn", $"⚠ {res.Unrecoverable} файлов вернуть не удалось: их пришлось обработать напрямую (обычно слишком длинный путь). Удалённые стёрты безвозвратно; перезаписанные заменены версией с источника."));
            }
            else
            {
                var skip = res.SkippedTotal > 0
                    ? new Notice("note", $"Пропущено без доступа: {res.SkippedTotal} папок и файлов. Они не тронуты ни на одной стороне.")
                    : null;
                if (res.Failures > 0)
                {
                    ProgressText = $"Готово с ошибками: {res.Failures} файлов не удалось";
                    var sample = string.Join("\n", res.FailuresSample ?? []);
                    Message("warn", $"⚠ Не удалось обработать {res.Failures} файлов (нет прав или заняты):\n{sample}{(res.Failures > 5 ? "\n…" : "")}");
                    if (skip != null) Notices.Add(skip);
                }
                else
                {
                    ProgressText = "Готово ✓";
                    if (skip != null)
                    {
                        StatsVisible = false;
                        Notices.Clear();
                        Notices.Add(skip);
                    }
                }
            }
            ConfirmText = "Закрыть";
            ConfirmEnabled = true;
            _confirmMode = "close";
        }
        catch (Exception err)
        {
            // Без этого «Выполнить» осталась бы заблокированной, а окно закрывалось бы
            // только «Отменой», без обновления списка.
            ProgressText = $"Ошибка: {err.Message}";
            ProgressIndeterminate = false;
            ConfirmText = "Закрыть";
            ConfirmEnabled = true;
            _confirmMode = "close";
        }
        finally
        {
            _syncRunning = false;
            CancelText = "Отмена";
            CancelEnabled = true;
        }
    }
}

/// <summary>Окно истории (openHistory, renderHistory, historyFilesHtml в renderer.js).</summary>
public sealed partial class HistoryModel(MainViewModel main) : ObservableObject
{
    [ObservableProperty] private bool _isOpen;
    [ObservableProperty] private string? _emptyText;
    public ObservableCollection<HistoryRunRow> Runs { get; } = new();

    public async Task Open()
    {
        Runs.Clear();
        EmptyText = "Загрузка…";
        IsOpen = true;
        Render(await main.Api.GetHistory());
    }

    public void Close() => IsOpen = false;

    public async Task Clear()
    {
        await main.Api.ClearHistory();
        Render(new List<HistoryRun>());
    }

    public void Render(List<HistoryRun> list)
    {
        Runs.Clear();
        if (list.Count == 0)
        {
            EmptyText = "Пока нет записей — история появится после синхронизации.";
            return;
        }
        EmptyText = null;
        foreach (var run in list)
        {
            var t = run.Totals ?? new HistoryTotals();
            var counts = new List<Part>();
            if (t.Move > 0) counts.Add(new Part("move", $"→{t.Move}"));
            if (t.Copy > 0) counts.Add(new Part("copy", $"+{t.Copy}"));
            if (t.Overwrite > 0) counts.Add(new Part("overwrite", $"~{t.Overwrite}"));
            if (t.Trash > 0) counts.Add(new Part("trash", $"−{t.Trash}"));
            if (counts.Count == 0) counts.Add(new Part("none", "без изменений"));
            var badges = new List<Part>();
            // Записи старых версий: «безвозвратно» считалось отдельно.
            if (run.Other != null && run.Other.TryGetValue("permanentDeletes", out var pd) && pd.TryGetInt32(out var n) && n > 0)
                badges.Add(new Part("danger", $"безвозвратно: {n}"));
            if (run.Failures > 0) badges.Add(new Part("warn", $"ошибок: {run.Failures}"));
            Runs.Add(new HistoryRunRow
            {
                Run = run,
                Time = Format.FmtDateTime(run.Time),
                Dir = run.Direction == "toNetwork" ? "Локально → Сеть" : "Сеть → Локально",
                Counts = counts,
                Badges = badges,
            });
        }
    }

    // Строки файлов строим только при первом раскрытии: заранее - это до миллиона строк
    // при полной истории, и окно вставало ещё до показа.
    public void Toggle(HistoryRunRow row)
    {
        if (!row.IsExpanded && row.Files == null) row.Files = FilesOf(row.Run);
        row.IsExpanded = !row.IsExpanded;
    }

    // Старые записи хранятся без перечня - тогда говорим об этом прямо, а не пустотой.
    public static List<Part> FilesOf(HistoryRun run)
    {
        if (run.DetailsDropped == true)
        {
            var n = run.FileCount is { } c ? $" ({Format.FmtNum(c)})" : "";
            return [new Part("muted", $"Список файлов{n} не сохранён: подробности хранятся только у последних запусков.")];
        }
        var sym = new Dictionary<string, string> { ["trash"] = "−", ["overwrite"] = "~", ["copy"] = "+", ["move"] = "→" };
        var files = (run.Files ?? []).Select(f => new Part(f.Action, $"{sym.GetValueOrDefault(f.Action, "")} {f.Path}")).ToList();
        if (run.FilesTruncated is > 0) files.Add(new Part("muted", $"…ещё {run.FilesTruncated} (не сохранены)"));
        return files.Count > 0 ? files : [new Part("muted", "Файлы не записаны.")];
    }
}
