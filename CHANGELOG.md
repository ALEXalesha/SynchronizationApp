# Changelog

What changed for the user in each release. The full text of each release, in English and
Russian, is in [docs/release-notes](docs/release-notes) (from 1.2.0) and on the
[releases page](https://github.com/ALEXalesha/SynchronizationApp/releases).

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
