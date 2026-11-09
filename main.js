const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsPromises = fs.promises;
const { spawn } = require('child_process');
const https = require('https');

let mainWindow;

// Tracks in-flight yt-dlp child processes: id -> { proc, intent, destinations, pollTimer }
// intent is 'run' unless we're the ones killing it on purpose ('pause' or 'cancel'),
// which tells the close handler how to interpret an exit that we triggered ourselves.
// destinations collects every "[download] Destination: ..." path yt-dlp reports,
// so a full cancel/discard can clean up partial files.
const runningProcesses = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ---- Bundled / auto-fetched binaries --------------------------------------
//
// yt-dlp ships inside the app (bin/win or bin/linux). On first run it's copied
// into userData (always writable, regardless of where the app itself is
// installed) and then self-updated in place via `yt-dlp -U` — so the bundled
// copy you shipped keeps itself current against new YouTube changes without
// needing a whole new app release each time yt-dlp cuts a new version.
//
// ffmpeg is NOT bundled (a static build is ~100MB+); on Windows, if it's not
// already on the system, the app downloads a static build once into userData
// and reuses it from then on. On Linux/macOS it's just expected on PATH
// (a one-line install via the system package manager).

function ytdlpBinaryName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function ffmpegBinaryName() {
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function bundledBinDir() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
  const platformDir = process.platform === 'win32' ? 'win' : process.platform;
  return path.join(base, platformDir);
}

function ytdlpCachePath() {
  return path.join(app.getPath('userData'), 'yt-dlp-bin', ytdlpBinaryName());
}

let resolvedYtdlpPath = null;

function getYtdlpPath() {
  if (resolvedYtdlpPath && fs.existsSync(resolvedYtdlpPath)) return resolvedYtdlpPath;
  const cached = ytdlpCachePath();
  if (fs.existsSync(cached)) return cached;
  const bundled = path.join(bundledBinDir(), ytdlpBinaryName());
  if (fs.existsSync(bundled)) return bundled;
  return ytdlpBinaryName(); // fall back to system PATH
}

// Copies the bundled yt-dlp into userData (if not already there) so it has a
// writable home, then runs `yt-dlp -U` against that copy to self-update.
// Runs once per app launch, in the background — never blocks startup, since
// getYtdlpPath() happily falls back to the bundled copy until this finishes.
function ensureYtdlp(onStatus) {
  const cached = ytdlpCachePath();

  try {
    if (!fs.existsSync(cached)) {
      const bundled = path.join(bundledBinDir(), ytdlpBinaryName());
      if (fs.existsSync(bundled)) {
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.copyFileSync(bundled, cached);
        if (process.platform !== 'win32') fs.chmodSync(cached, 0o755);
      }
    }
  } catch (err) {
    onStatus && onStatus({ state: 'error', message: err.message });
    return; // fall back to whatever getYtdlpPath() resolves on its own
  }

  if (!fs.existsSync(cached)) return; // no bundled binary for this platform either

  resolvedYtdlpPath = cached;
  onStatus && onStatus({ state: 'checking' });

  const proc = spawn(cached, ['-U', '--no-warnings'], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  let out = '';
  proc.stdout.on('data', (c) => (out += c.toString()));
  proc.stderr.on('data', (c) => (out += c.toString()));
  proc.on('error', () => {
    onStatus && onStatus({ state: 'error', message: 'Could not run yt-dlp self-update.' });
  });
  proc.on('close', () => {
    const text = out.trim();
    if (/up.to.date/i.test(text)) {
      onStatus && onStatus({ state: 'up-to-date' });
    } else if (/updat(ed|ing)/i.test(text)) {
      const versionMatch = text.match(/to\s+([\d.]+)/i);
      onStatus && onStatus({ state: 'updated', version: versionMatch ? versionMatch[1] : null });
    } else {
      onStatus && onStatus({ state: 'checked' });
    }
    console.log('[fetch] yt-dlp self-update result:', text || '(no output)');
  });
}

function resolveOnPath(cmd) {
  return new Promise((resolve) => {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const proc = spawn(checker, [cmd]);
    let stdout = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    proc.on('close', (code) => {
      if (code === 0) {
        const firstLine = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
        resolve(firstLine || null);
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

function ffmpegCacheDir() {
  return path.join(app.getPath('userData'), 'ffmpeg-bin');
}

function httpGetJSON(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'fetch-video-download-manager' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          resolve(httpGetJSON(res.headers.location, redirectsLeft - 1));
          return;
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'fetch-video-download-manager' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          downloadFile(res.headers.location, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received / total);
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve()));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });
}

function findFileRecursive(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = findFileRecursive(full, filename);
      if (result) return result;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

// Resolves a usable ffmpeg path: cached copy > system PATH > one-time download.
async function ensureFfmpeg(onProgress) {
  const cachedExe = path.join(ffmpegCacheDir(), ffmpegBinaryName());
  if (fs.existsSync(cachedExe)) {
    onProgress && onProgress({ state: 'ready' });
    return cachedExe;
  }

  onProgress && onProgress({ state: 'checking' });

  const onPathPath = await resolveOnPath(ffmpegBinaryName().replace('.exe', ''));
  if (onPathPath) {
    onProgress && onProgress({ state: 'ready' });
    console.log('[fetch] using system ffmpeg at', onPathPath);
    return onPathPath;
  }

  if (process.platform !== 'win32') {
    onProgress && onProgress({ state: 'error', message: 'ffmpeg not found on PATH.' });
    return null;
  }

  const tmpZip = path.join(os.tmpdir(), 'fetch-ffmpeg-download.zip');
  const extractDir = path.join(os.tmpdir(), 'fetch-ffmpeg-extract');
  fs.rmSync(extractDir, { recursive: true, force: true });

  try {
    const release = await httpGetJSON('https://api.github.com/repos/GyanD/codexffmpeg/releases/latest');
    const asset = (release.assets || []).find((a) => /essentials_build\.zip$/i.test(a.name));
    if (!asset) throw new Error('Could not find an ffmpeg build to download.');

    onProgress && onProgress({ state: 'downloading', percent: 0 });
    await downloadFile(asset.browser_download_url, tmpZip, (fraction) => {
      onProgress && onProgress({ state: 'downloading', percent: Math.round(fraction * 100) });
    });

    onProgress && onProgress({ state: 'extracting' });
    await new Promise((resolve, reject) => {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${tmpZip}' -DestinationPath '${extractDir}' -Force`,
      ]);
      ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Extraction failed.'))));
      ps.on('error', reject);
    });

    const found = findFileRecursive(extractDir, ffmpegBinaryName());
    if (!found) throw new Error('ffmpeg.exe not found after extracting.');

    fs.mkdirSync(ffmpegCacheDir(), { recursive: true });
    fs.copyFileSync(found, cachedExe);

    onProgress && onProgress({ state: 'ready' });
    return cachedExe;
  } catch (err) {
    onProgress && onProgress({ state: 'error', message: err.message });
    return null;
  } finally {
    fs.rm(tmpZip, () => {});
    fs.rm(extractDir, { recursive: true, force: true }, () => {});
  }
}

let resolvedFfmpegPath = null;

// ---- Settings (cookies-from-browser choice, subtitle default) -------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_e) {
    return {};
  }
}

function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  } catch (_e) {
    // Non-fatal — worst case, the setting doesn't persist across restarts.
  }
  return merged;
}

// ---- History (persists across restarts, separate from the live queue) -----

function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_e) {
    return [];
  }
}

function saveHistory(list) {
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    fs.writeFileSync(historyPath(), JSON.stringify(list, null, 2));
  } catch (_e) {
    // Non-fatal.
  }
}

function addHistoryEntry(entry) {
  const list = loadHistory();
  list.unshift(entry);
  if (list.length > 500) list.length = 500;
  saveHistory(list);
}

// ---- Cookies-from-browser / subtitles arg builders -------------------------

function buildCookieArgs(settings) {
  if (settings && settings.cookiesBrowser && settings.cookiesBrowser !== 'none') {
    return ['--cookies-from-browser', settings.cookiesBrowser];
  }
  return [];
}

function buildSubtitleArgs(wantSubtitles) {
  if (!wantSubtitles) return [];
  const args = ['--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en'];
  if (resolvedFfmpegPath) args.push('--convert-subs', 'srt');
  return args;
}

// ---- Per-download temp isolation (also drives disk-polled progress) -------

const TEMP_ROOT = path.join(os.tmpdir(), 'fetch-video-dl');

function tempDirFor(id) {
  return path.join(TEMP_ROOT, String(id));
}

function cleanupTempDir(id) {
  fs.rm(tempDirFor(id), { recursive: true, force: true }, () => {});
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

function formatLabel(formatChoice) {
  switch (formatChoice) {
    case '1080p':
      return '1080p';
    case '720p':
      return '720p';
    case '480p':
      return '480p';
    case 'audio':
      return 'audio';
    case 'best':
    default:
      return 'best';
  }
}

function buildFormatArgs(formatChoice) {
  switch (formatChoice) {
    case '1080p':
      return ['-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'];
    case '720p':
      return ['-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]'];
    case '480p':
      return ['-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]'];
    case 'audio':
      return ['-x', '--audio-format', 'mp3'];
    case 'best':
    default:
      return ['-f', 'bestvideo+bestaudio/best'];
  }
}

function runYtDlpJSON(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(getYtdlpPath(), args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('YTDLP_NOT_FOUND'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function friendlyYtdlpError(rawMessage) {
  const msg = (rawMessage || '').toString();
  const errorLine = msg
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^ERROR:/i.test(l));
  const core = (errorLine || msg).replace(/^ERROR:\s*/i, '').trim();

  if (/sign in to confirm your age|age.?restrict/i.test(core)) {
    return 'This video is age-restricted and needs a signed-in account to view — not something this app can get past.';
  }
  if (/sign in to confirm (you.?re not a bot|you are not a bot)/i.test(core)) {
    return "YouTube is asking to confirm you're not a bot — this happens on and off across yt-dlp and usually needs either an updated yt-dlp or your browser's cookies. Try the Cookies dropdown (pick your browser, fully closed first), or try again shortly.";
  }
  if (/private video/i.test(core)) {
    return "This video is private — you'd need access on the original site to download it.";
  }
  if (/video (unavailable|has been removed)/i.test(core) || /this video is not available/i.test(core)) {
    return 'This video is unavailable or has been removed from the site.';
  }
  if (/not available in your country|geo.?restrict/i.test(core)) {
    return "This video isn't available in your region.";
  }
  if (/unsupported url|no extractor/i.test(core)) {
    return "This site isn't supported. yt-dlp only works with sites it has explicit support for (YouTube, Vimeo, Twitch, and hundreds of others) — this one isn't on that list.";
  }
  if (/http error 403/i.test(core)) {
    return 'The site refused the request (403). This can happen when yt-dlp needs an update — try again in a bit.';
  }
  if (/unable to download webpage|network is unreachable|getaddrinfo/i.test(core)) {
    return 'Could not reach that site — check your internet connection and the URL.';
  }

  return core || 'Could not read that URL.';
}

async function probeExpectedBytes(url, formatArgs, cookieArgs) {
  try {
    const stdout = await runYtDlpJSON([
      '-J',
      '--no-playlist',
      '--no-warnings',
      '--ignore-config',
      ...formatArgs,
      ...(cookieArgs || []),
      url,
    ]);
    const info = JSON.parse(stdout);
    if (Array.isArray(info.requested_formats) && info.requested_formats.length) {
      const total = info.requested_formats.reduce(
        (sum, f) => sum + (f.filesize || f.filesize_approx || 0),
        0
      );
      return total > 0 ? total : null;
    }
    const single = info.filesize || info.filesize_approx || 0;
    return single > 0 ? single : null;
  } catch (_e) {
    return null;
  }
}

// ---- App lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  for (const [, entry] of runningProcesses) {
    try {
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      entry.proc.kill();
    } catch (_e) {
      // already dead, ignore
    }
  }
  fs.rm(TEMP_ROOT, { recursive: true, force: true }, () => {});
});

// ---- Auto-update (app itself, via electron-updater + GitHub Releases) -----

function setupAutoUpdater() {
  if (!app.isPackaged) return; // nothing published to check against in dev

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (_e) {
    return; // electron-updater not installed yet — fine, just skip
  }

  const send = (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', status);
    }
  };

  autoUpdater.autoDownload = true;

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send({ state: 'error', message: err.message }));

  autoUpdater.checkForUpdates();

  ipcMain.handle('install-update', async () => {
    autoUpdater.quitAndInstall();
  });
}

// ---- IPC handlers -----------------------------------------------------------

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('default-download-folder', async () => {
  return path.join(os.homedir(), 'Downloads');
});

ipcMain.handle('open-folder', async (_event, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('ensure-ffmpeg', async () => {
  const result = await ensureFfmpeg((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg-status', status);
    }
  });
  resolvedFfmpegPath = result;

  // Kick off yt-dlp's own self-update now too — after ffmpeg is sorted, since
  // both can download over the network and there's no need to race them.
  ensureYtdlp((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ytdlp-status', status);
    }
  });

  return { ok: !!result, path: result };
});

ipcMain.handle('get-settings', async () => loadSettings());

ipcMain.handle('set-settings', async (_event, partial) => saveSettings(partial));

ipcMain.handle('get-history', async () => loadHistory());

ipcMain.handle('remove-history-entry', async (_event, historyId) => {
  saveHistory(loadHistory().filter((h) => h.id !== historyId));
  return true;
});

ipcMain.handle('clear-history', async () => {
  saveHistory([]);
  return true;
});

ipcMain.handle('resolve-url', async (_event, url) => {
  try {
    const settings = loadSettings();
    const stdout = await runYtDlpJSON([
      '-J',
      '--flat-playlist',
      '--no-warnings',
      '--ignore-config',
      ...buildCookieArgs(settings),
      url,
    ]);
    const info = JSON.parse(stdout);
    if (!info || typeof info !== 'object') {
      throw new Error("yt-dlp didn't return usable info for this video.");
    }

    const bestThumb = (thumbnails, fallback) => {
      if (fallback) return fallback;
      if (Array.isArray(thumbnails) && thumbnails.length) {
        return thumbnails[thumbnails.length - 1].url || null;
      }
      return null;
    };

    if (info._type === 'playlist' && Array.isArray(info.entries)) {
      const items = info.entries
        .filter(Boolean)
        .map((entry) => {
          let entryUrl = entry.url;
          if (entryUrl && !/^https?:\/\//i.test(entryUrl)) {
            if (entry.ie_key && /youtube/i.test(entry.ie_key)) {
              entryUrl = `https://www.youtube.com/watch?v=${entry.url}`;
            } else if (entry.webpage_url) {
              entryUrl = entry.webpage_url;
            }
          }
          return {
            url: entryUrl || entry.webpage_url || url,
            title: entry.title || entry.id || 'Untitled video',
            thumbnail: bestThumb(entry.thumbnails, entry.thumbnail),
          };
        });
      return {
        type: 'playlist',
        playlistTitle: info.title || 'Playlist',
        items,
      };
    }

    return {
      type: 'video',
      items: [
        {
          url: info.webpage_url || url,
          title: info.title || 'Untitled video',
          thumbnail: bestThumb(info.thumbnails, info.thumbnail),
        },
      ],
    };
  } catch (err) {
    if (err.message === 'YTDLP_NOT_FOUND') {
      throw new Error(
        'yt-dlp was not found. Try reinstalling the app — see README.md if the problem continues.'
      );
    }
    throw new Error(friendlyYtdlpError(err.message));
  }
});

// Start downloading a single queue item; streams progress back over 'download-progress'.
// Used both to start a fresh download AND to resume a paused one (yt-dlp resumes
// partial files on its own as long as the same output path is used again).
ipcMain.handle('start-download', async (event, { id, url, folder, format, title, thumbnail, subtitles }) => {
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', { id, ...payload });
    }
  };

  const tempDir = tempDirFor(id);

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    const settings = loadSettings();
    const formatArgs = buildFormatArgs(format);
    const cookieArgs = buildCookieArgs(settings);
    const subtitleArgs = buildSubtitleArgs(subtitles);

    const expectedBytesPromise = probeExpectedBytes(url, formatArgs, cookieArgs);

    const args = [
      ...formatArgs,
      ...cookieArgs,
      ...subtitleArgs,
      '--newline',
      '--no-color',
      '--no-warnings',
      '--ignore-config',
      '--print',
      'after_move:FILEPATH %(filepath)s',
      '-P',
      `temp:${tempDir}`,
      '-P',
      `home:${folder}`,
      '-o',
      `%(title)s [${formatLabel(format)}].%(ext)s`,
    ];

    if (resolvedFfmpegPath) {
      args.push('--ffmpeg-location', resolvedFfmpegPath);
    }
    args.push(url);

    const ytdlpPath = getYtdlpPath();
    console.log(`[fetch] starting download #${id}:`, ytdlpPath, args.join(' '));

    const proc = spawn(ytdlpPath, args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    const entry = { proc, intent: 'run', destinations: [], pollTimer: null };
    runningProcesses.set(id, entry);

    let stderrTail = '';
    let finalFilePath = null;
    let expectedBytes = null;
    expectedBytesPromise.then((bytes) => {
      expectedBytes = bytes;
    });

    let lastPollBytes = 0;
    let lastPollTime = Date.now();

    entry.pollTimer = setInterval(() => {
      fs.readdir(tempDir, { withFileTypes: true }, (err, files) => {
        if (err || !files) return;
        let bytesSoFar = 0;
        let pending = files.length;
        if (pending === 0) return;
        files.forEach((f) => {
          if (!f.isFile()) {
            pending--;
            return;
          }
          fs.stat(path.join(tempDir, f.name), (statErr, st) => {
            if (!statErr && st) bytesSoFar += st.size;
            pending--;
            if (pending === 0) {
              const now = Date.now();
              const elapsed = (now - lastPollTime) / 1000;
              const bytesDelta = bytesSoFar - lastPollBytes;
              const bytesPerSec = elapsed > 0 ? bytesDelta / elapsed : 0;
              lastPollBytes = bytesSoFar;
              lastPollTime = now;

              const percent = expectedBytes ? Math.min(99, (bytesSoFar / expectedBytes) * 100) : null;
              const etaSeconds =
                expectedBytes && bytesPerSec > 0
                  ? Math.max(0, Math.round((expectedBytes - bytesSoFar) / bytesPerSec))
                  : null;

              send({
                status: 'downloading',
                percent,
                total: expectedBytes ? formatBytes(expectedBytes) : `${formatBytes(bytesSoFar)} so far`,
                speed: bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '',
                eta: etaSeconds != null ? `${Math.floor(etaSeconds / 60)}:${String(etaSeconds % 60).padStart(2, '0')}` : '',
              });
            }
          });
        });
      });
    }, 700);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
      text.split('\n').forEach((line) => {
        line = line.trim();
        if (!line) return;

        if (line.startsWith('FILEPATH')) {
          finalFilePath = line.replace('FILEPATH', '').trim();
        } else if (/^\[(Merger|ExtractAudio|VideoConvertor)\]/.test(line)) {
          send({ status: 'processing', message: line });
        } else {
          const destMatch = line.match(/^\[download\] Destination:\s*(.+)$/);
          if (destMatch) {
            entry.destinations.push(destMatch[1].trim());
          } else if (/has already been downloaded/i.test(line)) {
            send({ status: 'done', percent: 100, message: 'Already downloaded' });
          }
        }
      });
    });

    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      console.error(`[fetch] yt-dlp stderr #${id}:`, chunk.toString().trim());
    });

    proc.on('error', (err) => {
      clearInterval(entry.pollTimer);
      runningProcesses.delete(id);
      cleanupTempDir(id);
      if (err.code === 'ENOENT') {
        send({
          status: 'error',
          message: `Couldn't run yt-dlp (${ytdlpPath}). See README.md.`,
        });
      } else {
        send({ status: 'error', message: err.message });
      }
    });

    proc.on('close', (code) => {
      clearInterval(entry.pollTimer);
      const wasEntry = runningProcesses.get(id);
      runningProcesses.delete(id);
      const intent = wasEntry ? wasEntry.intent : 'run';

      if (intent === 'pause') {
        // Deliberately NOT cleaning up the temp dir here — the partial fragments
        // in it are exactly what lets Resume pick back up instead of restarting.
        send({ status: 'paused' });
        return;
      }

      cleanupTempDir(id);

      if (intent === 'cancel') {
        send({ status: 'cancelled' });
        return;
      }
      if (code === 0) {
        const histEntry = {
          id: `${id}-${Date.now()}`,
          title: title || 'Untitled video',
          url,
          format,
          filepath: finalFilePath,
          thumbnail: thumbnail || null,
          timestamp: Date.now(),
        };
        addHistoryEntry(histEntry);
        send({ status: 'done', percent: 100, filepath: finalFilePath });
      } else {
        const lines = stderrTail.trim().split('\n').filter(Boolean);
        const errorLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l.trim()));
        send({
          status: 'error',
          message: friendlyYtdlpError(errorLine || lines[lines.length - 1] || `yt-dlp exited with code ${code}`),
        });
      }
    });

    return true;
  } catch (err) {
    cleanupTempDir(id);
    send({ status: 'error', message: err.message || 'Failed to start download.' });
    return false;
  }
});

// Pause: kill the process but deliberately keep its temp fragments on disk.
ipcMain.handle('pause-download', async (_event, id) => {
  const entry = runningProcesses.get(id);
  if (!entry) return false;
  entry.intent = 'pause';
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  entry.proc.kill();
  return true;
});

// Cancel/discard: kill the process (if still running) and best-effort delete any
// partial files it had started writing — including the temp dir, which matters
// especially for discarding an already-paused item (its process already exited,
// so this is the only place left to clean up its leftover fragments).
ipcMain.handle('cancel-download', async (_event, id, knownDestinations) => {
  const entry = runningProcesses.get(id);
  const destinations = entry ? entry.destinations : knownDestinations || [];

  if (entry) {
    entry.intent = 'cancel';
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    entry.proc.kill();
  } else {
    cleanupTempDir(id);
  }

  for (const dest of destinations) {
    for (const suffix of ['', '.part', '.ytdl']) {
      try {
        await fsPromises.unlink(dest + suffix);
      } catch (_e) {
        // ignore — file may not exist
      }
    }
  }

  return true;
});

ipcMain.handle('delete-file', async (_event, filepath) => {
  if (!filepath) return false;
  try {
    await fsPromises.unlink(filepath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
});
