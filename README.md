# Fetch — Video Download Manager

A small Electron desktop app that works like a real download manager, but for videos:
paste a URL, and it downloads a single video **or** expands a playlist URL into
individual queued items automatically, each with its own progress bar, speed, and ETA.

It doesn't implement any downloading logic itself — it's a UI + queue manager wrapped
around [yt-dlp](https://github.com/yt-dlp/yt-dlp), the open-source engine that supports
YouTube and hundreds of other sites.

## Prerequisites

Only one thing to install yourself:

1. **Node.js** (v18+) — https://nodejs.org — needed to build/run the app itself.

That's it for setup. The two things a video downloader actually needs are handled
automatically:

- **yt-dlp** ships bundled inside the app (`bin/win/yt-dlp.exe`) — nothing to install.
- **ffmpeg** is auto-detected on first launch. If it's already on your system, the app
  just uses it. If not, the app silently downloads a Windows build (~100MB, one-time)
  and caches it for every run after that. You'll see a small banner at the top of the
  app the first time this happens — it takes a minute or two depending on your
  connection, then disappears and you're good to go.

## Install & run

```bash
npm install
npm start
```

## Packaging into a standalone .exe

This is wired up with [electron-builder](https://www.electron.build/) already. From
inside the project folder, in your terminal:

```powershell
npm install
npm run dist
```

That produces a proper Windows installer at `dist\Fetch Setup 1.0.0.exe` — around
20-30MB (yt-dlp is bundled in; ffmpeg is not, since it downloads itself on first run
per the note above). Run that installer and it installs the app like any normal
program, with a Start Menu entry and desktop shortcut — no terminal, no `npm start`,
no separate downloads for anyone using the built app.

## Queue controls

Each item in the queue shows action button(s) based on its current state:
- **Pause** — while downloading, stops the process but keeps partial files on disk.
- **Resume** — restarts a paused item; yt-dlp picks up from the partial file rather
  than starting over. Also used as **Retry** on failed items.
- **Discard** — from a paused state, stops it for good and deletes the partial files.
- **Delete** — once done, deletes the finished file from disk and removes it from the list.
- **Remove** — for queued/errored/cancelled items, just clears the list entry.

## Thumbnails

Each queue and history item shows a thumbnail pulled from the source site's metadata,
where available. Falls back to a placeholder glyph if the site doesn't provide one or
the image fails to load.

## Subtitles

The **Subtitles** checkbox next to the folder picker downloads captions alongside the
video — both manually-authored and auto-generated ones, in English by default (see
`buildSubtitleArgs` in `main.js` to change the language). If ffmpeg is available,
subtitles are converted to `.srt`; otherwise they're saved in whatever format the site
serves (usually `.vtt`). The checkbox state applies per-item at the moment you click
**Add to queue**, and your last choice is remembered for next time.

## Cookies (for private/unlisted videos you have access to)

The **Cookies** dropdown lets yt-dlp borrow your browser's login session, which is
needed for anything gated behind a sign-in — private/unlisted videos you have access
to, members-only content, etc. Pick your browser (Chrome, Edge, Firefox, Brave) and
it applies to every URL you add from then on, persisted across restarts.

Two things worth knowing:
- Your selected browser usually needs to be **fully closed** for yt-dlp to read its
  cookie database (Chrome/Edge lock the file while running).
- This only helps with content *you* can already see when logged into that browser —
  it doesn't bypass paywalls or access controls you don't otherwise have.

## History

A **History** tab (next to Manifest) keeps a permanent record of every completed
download — title, thumbnail, format, and timestamp — that persists across app
restarts (stored in a local `history.json` in the app's user data folder, capped at
the most recent 500 entries). Each entry has:
- **Open folder** — reveals the downloaded file in Explorer.
- **Delete** — deletes the actual file from disk and removes the history entry.
- **Remove** — clears just the history entry (e.g. if you already deleted the file
  yourself), without touching anything on disk.

There's also a **Clear history** button (visible while on the History tab) to wipe the
whole list at once — it only clears the list, never deletes any files.

## What to give someone else

If you want another person to run this without touching a terminal, the **only** file
they need is the installer:

```
dist\Fetch Setup 1.0.0.exe
```

That single `.exe` is self-contained — running it installs the whole app (yt-dlp
included) to their machine, with a desktop shortcut. They don't need the project
folder, `node_modules`, or anything else; you can delete/ignore the rest of `dist\`
(electron-builder also writes some unpacked build artifacts alongside it, like a
`win-unpacked\` folder, which you can ignore or delete — only the `Setup ...exe` is
meant to be shared). No zipping needed, just hand them that one file directly (email,
USB drive, cloud link, whatever).

## How it works

- `main.js` — Electron main process. Spawns the bundled `yt-dlp` for both metadata
  lookup (`--flat-playlist -J`, to detect playlists vs. single videos, plus
  thumbnails) and the actual download, tracking real-time progress via disk
  polling (see below) rather than yt-dlp's own progress text. Also handles
  resolving/auto-downloading ffmpeg on first run, settings persistence (cookies
  browser, subtitle default), and the history log.
- `preload.js` — exposes a small, safe `window.api` bridge (contextIsolation is on,
  nodeIntegration is off).
- `renderer/` — the UI: paste a URL, pick quality/format/subtitles/cookies, watch
  the queue, browse history.
- `bin/win/yt-dlp.exe` — the bundled download engine, packaged into the installer via
  `extraResources` in `package.json`.

**Real-time progress**: yt-dlp's own `--progress-template` output isn't delivered
in real time when piped through a GUI app (a confirmed upstream limitation — see
their issue tracker) — it batches and dumps everything near the end instead. To get
around that, each download writes its in-progress fragments to a private temp folder,
and the app polls that folder's actual size on disk every ~700ms to compute a real
live percentage, speed, and ETA — independent of whatever yt-dlp's own text is doing.

Quality options map to yt-dlp format selectors:
- **Best** → `bestvideo+bestaudio/best`
- **1080p / 720p / 480p** → capped by height
- **Audio only** → extracted to MP3

Each queue item downloads into its own temp scratch folder and the final filename
includes the quality label (e.g. `Song Title [720p].mp4`), so downloading the same
video in multiple qualities at once no longer collides or corrupts files.

Up to 3 downloads run concurrently by default (see `MAX_CONCURRENT` in
`renderer/renderer.js`).

All in-flight yt-dlp processes are killed when the app quits, so nothing keeps
running (or eating disk space) in the background after you close the window.

## A note on how you use this

This app is a generic client for yt-dlp — the same kind of tool as many existing
open-source GUIs for it. What you download with it is between you and the terms of
service of whatever site you're pulling from. Most platforms, including YouTube,
restrict downloading content you don't own the rights to (outside of things like
your own uploads, permissively-licensed videos, or content explicitly marked
downloadable). Worth keeping in mind, especially for anything you plan to
re-share or use outside personal/offline viewing.
