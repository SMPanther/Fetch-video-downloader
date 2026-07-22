const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsPromises = fs.promises;
const { spawn } = require('child_process');

let mainWindow;

// Tracks in-flight yt-dlp child processes: id -> { proc, intent, destinations }
// intent is 'run' unless we're the ones killing it on purpose ('pause' or 'cancel'),
// which tells the close handler how to interpret an exit that we triggered ourselves.
// destinations collects every "[download] Destination: ..." path yt-dlp reports,
// so a full cancel/discard can clean up partial files.
const runningProcesses = new Map();

// ---- Bundled / auto-fetched binaries ------------------------------------
//
// yt-dlp.exe ships inside the app itself (small, ~18MB) — see bin/win/.
// ffmpeg is NOT bundled (a static build is ~100MB+); instead, on first run,
// if it's not already on the system, we download it once into userData and
// reuse it from then on.

const https = require('https');

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

function getYtdlpPath() {
  const bundled = path.join(bundledBinDir(), ytdlpBinaryName());
  if (fs.existsSync(bundled)) return bundled;
  return ytdlpBinaryName(); // fall back to system PATH
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

// ---- Settings (cookies-from-browser choice, subtitle default) -----------
// Small JSON file in userData — no need for a real database for two fields.

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

// ---- History (persists across restarts, separate from the live queue) ---

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
    // Non-fatal — worst case, this run's history entry doesn't persist.
  }
}

function addHistoryEntry(entry) {
  const list = loadHistory();
  list.unshift(entry); // newest first
  if (list.length > 500) list.length = 500; // keep the file from growing forever
  saveHistory(list);
}

// ---- Cookies-from-browser / subtitles arg builders -----------------------

function buildCookieArgs(settings) {
  if (settings && settings.cookiesBrowser && settings.cookiesBrowser !== 'none') {
    return ['--cookies-from-browser', settings.cookiesBrowser];
  }
  return [];
}

function buildSubtitleArgs(wantSubtitles) {
  if (!wantSubtitles) return [];
  const args = ['--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en'];
  // Conversion to .srt needs ffmpeg; if we don't have one resolved yet, subs still
  // download fine, just in whatever format the site serves (usually .vtt).
  if (resolvedFfmpegPath) args.push('--convert-subs', 'srt');
  return args;
}

// Resolves a usable ffmpeg path: cached copy > system PATH > one-time download.
// onProgress receives { state: 'checking' | 'downloading' | 'extracting' | 'ready', percent? }
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
    // Auto-download is only wired up for Windows; other platforms should
    // install ffmpeg themselves (brew/apt), matching the README.
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Don't leave orphaned yt-dlp processes running (and eating disk space)
  // after the app window is closed.
  for (const [, entry] of runningProcesses) {
    try {
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      entry.proc.kill();
    } catch (_e) {
      // already dead, ignore
    }
  }
  // Also sweep any leftover temp fragments (e.g. from downloads that were left
  // paused when the app closed) so they don't sit around taking up space forever.
  fs.rm(TEMP_ROOT, { recursive: true, force: true }, () => {});
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- Helpers -------------------------------------------------------------

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
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Each download gets its own scratch folder for in-progress fragments — this both
// prevents two downloads of the same title (e.g. different qualities) from ever
// colliding on temp files, AND gives us an isolated folder we can poll for real-time
// progress (see below), independent of yt-dlp's own — currently unreliable when piped
// — progress text.
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

// Best-effort: ask yt-dlp for the expected total size of the format we're about to
// download, so disk-polling progress can show a real percentage. Failure is fine —
// we just fall back to showing bytes-downloaded without a fixed target.
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

// ---- IPC handlers -------------------------------------------------------

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

// Kicks off ffmpeg resolution (cached > system > one-time download), streaming
// progress to the renderer over 'ffmpeg-status'.
ipcMain.handle('ensure-ffmpeg', async () => {
  const result = await ensureFfmpeg((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg-status', status);
    }
  });
  resolvedFfmpegPath = result;
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

// Resolve a pasted URL into one or more downloadable items (expands playlists)
function friendlyYtdlpError(rawMessage) {
  const msg = (rawMessage || '').toString();
  // yt-dlp errors are usually one or more "ERROR: ..." lines, sometimes with a
  // traceback under them; pull out just the actual error text.
  const errorLine = msg
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^ERROR:/i.test(l));
  const core = (errorLine || msg).replace(/^ERROR:\s*/i, '').trim();

  if (/sign in to confirm your age|age.?restrict/i.test(core)) {
    return 'This video is age-restricted and needs a signed-in account to view — not something this app can get past.';
  }
  if (/private video/i.test(core)) {
    return "This video is private — you'd need access on the original site to download it.";
  }
  if (/video (unavailable|has been removed)/i.test(core)) {
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

    // Best-effort — doesn't block the actual download if it's slow or fails.
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
      // Fragments/partial files land in a per-job temp dir, both so concurrent
      // downloads of the same title never collide, and so we can reliably poll
      // "how many bytes has this specific job written" on disk ourselves —
      // yt-dlp's own --progress-template output isn't delivered in real time when
      // piped (a confirmed upstream limitation, not something we can flag our way
      // out of), so we don't rely on it for the live percentage anymore.
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

    // --- Real-time progress via disk polling -----------------------------
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
        // Prefer the last actual "ERROR: ..." line yt-dlp printed over just the
        // last line of stderr, which is often a generic retry/warning notice.
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

// Pause: kill the process but keep any partial files, so Resume (a plain
// start-download with the same id/url/folder/format) can pick up where it left off.
ipcMain.handle('pause-download', async (_event, id) => {
  const entry = runningProcesses.get(id);
  if (!entry) return false;
  entry.intent = 'pause';
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
    // Already exited (e.g. was paused) — nothing left to kill, but its temp
    // fragments are still on disk, so clean those up ourselves.
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
    if (err.code === 'ENOENT') return true; // already gone, treat as success
    throw err;
  }
});
