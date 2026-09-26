# Changelog

What changed for the user in each release. The full text of each release, in English and
Russian, is in [docs/release-notes](docs/release-notes) (from 1.2.0) and on the
[releases page](https://github.com/ALEXalesha/SynchronizationApp/releases).

## 1.2.4 - 2026-09-26 - Electron icon

- Electron: the version had no icon of its own - the taskbar, the shortcut and the
  installer showed the Electron atom. It now has one: two circular arrows on glass in the
  window's accent colour, simpler and bolder at 16-24 px so it stays readable on the
  taskbar; the same drawing is the logo in the window header. The C# version keeps its
  own icon. 261 C# tests and 207 JavaScript tests.

## 1.2.3 - 2026-09-26 - checkmark in the middle

- Both versions: the checkmark sat almost a pixel right of and nearly two pixels below the
  middle of the box, in Electron itself too, so matching Electron in 1.2.2 kept it off
  centre. It now sits in the middle of the box in both versions; a test measures its
  centre in the Electron reference and in the WPF render.
- C# tests no longer start the real program: they took the single-copy lock and opened a
  window on the real `%APPDATA%` data, and with SyncGlass running every window test failed.
  261 C# tests and 202 JavaScript tests.

## 1.2.2 - 2026-09-26 - checkmarks in place

- C#: the checkmark sat one pixel right of and below where Electron draws it. The window
  rounds its layout, the 1.5 px checkbox border became 2 px, and the checkmark was placed
  from the inner edge of that border. It is now placed from the outer edge, like the CSS
  `::after`; a new test compares the checkboxes in a real window at actual size with
  Electron at 1x (the 1.2.1 test compared 4x renders only, where the rounding does not
  show). 258 C# tests and 202 JavaScript tests.

## 1.2.1 - 2026-09-26 - no more stutter; checkboxes like the original

- Every refresh restarted the size scan, which re-read the 49 MB size cache from disk and
  poured 300,000 entries back into the window; switching the sort to date did the same.
  The heap grew to 900 MB and garbage collection froze the window for up to 1.6 s. Now the
  cache is sent only to a window that has no sizes yet, and sorting never restarts the
  scan (both versions).
- C#: expanding a history entry with 5,000 files took 8 s, opening a history of 200 runs
  1.2 s - both lists now build only the visible rows (14 ms and 65 ms). Expanding a folder
  in the tree no longer rebuilds the whole list (90 ms to 13 ms). The history file is read
  off the window thread.
- C#: checked checkboxes shrank to 13 px and the tick was drawn by its own crooked line;
  both now match the Electron checkbox, checked by comparing 4x renders.
- 257 C# tests and 202 JavaScript tests.

## 1.2.0 - 2026-09-26 - two versions: Electron and C#/WPF

- **C# version (new)**: the same window, tree, preview, history and rules in C# with WPF.
  A single `.exe` of 73 MB installed instead of 358 MB, its own dark title bar.
- Both versions share settings, history, the size cache and the window position in
  `%APPDATA%\SyncGlass`, and one single-instance lock: only one of them runs at a time.
- The C# version reads the size cache as a stream: on a real tree of 300,000 entries it holds
  about 640 MB, the Electron version about 855 MB on the same data.
- 248 C# tests and 199 JavaScript tests.

## 1.1.1 - 2026-09-25 - the size scan no longer eats memory

- The background scan queued a task for every file at once: 700 MB and 33 seconds on a
  folder with 300,000 entries. Now a fixed number of workers: 142 MB and 5.5 seconds.
- New law of scan memory. 197 tests.

## 1.1.0 - 2026-09-24 - the window opens where it was closed

- The window place is saved and checked against the monitors present at the next start;
  an unplugged monitor sends the window to the centre of the main one. 190 tests.

## 1.0.1 - 2026-09-23 - large counts fit the preview

- Six-digit counts no longer spill out of the preview tiles. 182 tests.

## 1.0.0 - 2026-09-23 - first public release

- Folder sync between a laptop and a networked PC: exact copy, moves recognised as moves,
  preview first, Stop puts everything back. 179 tests.
