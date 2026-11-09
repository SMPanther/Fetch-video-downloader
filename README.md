# Fetch — Video Download Manager

A small Electron desktop app that works like a real download manager, but for videos:
paste a URL, and it downloads a single video **or** expands a playlist URL into
individual queued items automatically, each with its own live progress bar, speed,
and ETA.

It doesn't implement any downloading logic itself — it's a UI + queue manager wrapped
around [yt-dlp](https://github.com/yt-dlp/yt-dlp), the open-source engine that supports
YouTube and hundreds of other sites.

## Prerequisites

Only one thing to install yourself:

1. **Node.js** (v18+) — https://nodejs.org — needed to build/run the app itself.

That's it. The two things a video downloader actually needs are handled automatically:

- **yt-dlp** ships bundled inside the app. On first run it's copied into a writable
  location and self-updates in place (`yt-dlp -U`) every time the app launches — so it
  stays current against YouTube's frequent changes without needing a whole new app
  release each time.
- **ffmpeg** is auto-detected on first launch. If it's already on your system, the app
  just uses it. On Windows, if not, the app downloads a static build (~100MB, one-time)
  and caches it. On Linux/macOS, install it with your package manager (see below).

## Install & run

```bash
npm install
npm start
```

## Packaging into a standalone Windows installer

```powershell
npm install
npm run dist
```

Produces `dist\Fetch Setup 1.0.0.exe` — a real installer with a Start Menu entry and
desktop shortcut. Needs `build/icon.ico` (a proper multi-size Windows icon, at least
256×256) to exist first — see "Icon" below.

## Building for Linux

Linux packages (`.AppImage`, `.deb`) use Linux-native packaging tools, so this step
needs to run on an actual Linux machine or **WSL** (Windows Subsystem for Linux).

```bash
# Inside WSL/Linux, from the project folder:
chmod +x bin/linux/yt-dlp   # git on Windows often drops the executable bit
npm install
npm run dist:linux
```

Produces `dist/Fetch-1.0.0.AppImage` and `dist/fetch_1.0.0_amd64.deb`. Needs
`build/icon.png` (512×512 recommended) to exist first.

ffmpeg isn't auto-downloaded on Linux — it's a one-line install:
```bash
sudo apt install ffmpeg   # Debian/Ubuntu
sudo dnf install ffmpeg   # Fedora
sudo pacman -S ffmpeg     # Arch
```

## Icon

- `build/icon.ico` — Windows, must be a real multi-resolution `.ico` (16 through at
  least 256px), not a renamed `.png`. Convert at https://icoconvert.com.
- `build/icon.png` — Linux, a plain 512×512 PNG.

## Auto-updates (the app itself)

The app checks GitHub Releases on startup (via `electron-updater`) and prompts to
restart when a newer version is ready. For this to work:

1. `package.json` → `build.publish` points at `SMPanther/Fetch-video-downloader`.
2. Every release needs **two files** attached: the installer `.exe` **and** the
   `latest.yml` file that `npm run dist` also generates in `dist/` — that file is what
   `electron-updater` reads to know a newer version exists. Forgetting to attach it
   means updates silently never trigger.
3. Bump `"version"` in `package.json` before each release.

Auto-update only runs in packaged builds (`app.isPackaged`), never in `npm start`.

## Queue controls

Each item shows action button(s) based on its state:
- **Pause** — stops the process but keeps partial files on disk.
- **Resume** — restarts a paused item; yt-dlp continues from the partial file instead
  of starting over. Also used as **Retry** on failed items.
- **Discard** — from paused, stops it for good and deletes the partial files.
- **Delete** — once done, deletes the finished file from disk and removes the entry.
- **Remove** — for queued/errored/cancelled items, just clears the list entry.

## Thumbnails

Every queue and history item shows a thumbnail pulled from the source site's metadata,
falling back to a placeholder glyph if none is available.

## Subtitles

The **Subtitles** checkbox downloads captions alongside the video (manual +
auto-generated, English by default — see `buildSubtitleArgs` in `main.js` to change
the language). Converted to `.srt` when ffmpeg is available. Your choice is remembered
across restarts.

## Cookies (for private/unlisted videos you have access to)

The **Cookies** dropdown lets yt-dlp borrow your browser's login session — needed for
anything gated behind sign-in. Your browser usually needs to be fully closed for
yt-dlp to read its cookie database. This only helps with content you can already see
logged in — it doesn't bypass access controls you don't otherwise have.

## History

A **History** tab lists every completed download permanently (survives restarts),
stored in `history.json` in the app's user data folder, capped at 500 entries. Each
entry has **Open folder**, **Delete** (removes the file), and **Remove** (clears just
the entry). **Clear history** wipes the whole list — never deletes files.

## How it works

- `main.js` — Electron main process. Spawns yt-dlp for metadata lookup and the actual
  download, tracks real-time progress via disk polling (see below), handles the
  ffmpeg/yt-dlp self-setup, settings, history, and the app's own auto-updater.
- `preload.js` — exposes a small, safe `window.api` bridge (contextIsolation on,
  nodeIntegration off).
- `renderer/` — the UI.
- `bin/win/yt-dlp.exe`, `bin/linux/yt-dlp` — the bundled download engine per platform.

**Real-time progress**: yt-dlp's own `--progress-template` output isn't delivered in
real time when piped through a GUI app (a confirmed upstream yt-dlp limitation) — it
batches and dumps everything near the end instead. To work around that, each download
writes its in-progress fragments to a private temp folder, and the app polls that
folder's size on disk every ~700ms to compute a real live percentage, speed, and ETA.

**yt-dlp self-update**: the bundled binary is copied to a writable per-user location
on first run (so it works regardless of where the app itself is installed, admin
rights or not), then `yt-dlp -U` runs against that copy on every launch in the
background — never blocking startup.

## A note on how you use this

This app is a generic client for yt-dlp — the same kind of tool as several existing
open-source GUIs for it. What you download with it is subject to the terms of service
of whatever site you're pulling from.
