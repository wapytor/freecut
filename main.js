const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// a stray error gets logged to userData/error.log instead of popping a native error dialog
process.on('uncaughtException', (e) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), new Date().toISOString() + ' ' + String((e && e.stack) || e) + '\n'); } catch {}
});

// fc:// serves local media with CORS headers so the canvas stays untainted
// (needed for chroma key pixel access and for exporting).
protocol.registerSchemesAsPrivileged([
  { scheme: 'fc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }
]);

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e0f13',
    title: 'FreeCut',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

/* ---------- persistent storage (survives restarts, shared by every project) ---------- */
const libDir = () => path.join(app.getPath('userData'), 'library');
const libIndex = () => path.join(libDir(), 'library.json');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // atomic-ish: never leave a half-written index
};
const STORES = new Set(['presets']);
const storeFile = (name) => path.join(app.getPath('userData'), name + '.json');

app.whenReady().then(() => {
  // Serves local media with real Content-Length + byte-range support. Without those, audio files report an
  // infinite duration and videos can't seek.
  const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  protocol.handle('fc', async (req) => {
    const p = new URL(req.url).searchParams.get('p');
    if (!p || !path.isAbsolute(p)) return new Response('bad request', { status: 400 });
    let st;
    try { st = await fs.promises.stat(p); } catch { return new Response('not found', { status: 404 }); }
    const size = st.size;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); }
      else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(size - 1, parseInt(m[2], 10)); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    if (size === 0 || start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Length'] = String(end - start + 1);
    return new Response(require('stream').Readable.toWeb(fs.createReadStream(p, { start, end })), { status, headers });
  });

  /* projects: Save writes straight to the known path; Save As (or first save) asks */
  ipcMain.handle('project:save', async (_e, { json, path: existing, saveAs }) => {
    let target = existing;
    if (!target || saveAs) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Save project',
        defaultPath: existing || 'untitled.freecut',
        filters: [{ name: 'FreeCut project', extensions: ['freecut'] }]
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, json, 'utf8');
    return target;
  });

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'FreeCut project', extensions: ['freecut'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
  });

  /* media library: files are COPIED into app storage so they outlive the originals */
  ipcMain.handle('lib:list', () => readJson(libIndex(), []));
  ipcMain.handle('lib:add', async (_e, { srcPath, name, type, duration, thumb }) => {
    if (!srcPath || !path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) throw new Error('File not found');
    const id = crypto.randomUUID();
    const file = path.join(libDir(), id + path.extname(srcPath));
    fs.mkdirSync(libDir(), { recursive: true });
    await fs.promises.copyFile(srcPath, file);
    const item = { id, name, type, duration, thumb, file, src: srcPath, added: Date.now() };
    const list = readJson(libIndex(), []);
    list.push(item);
    writeJson(libIndex(), list);
    return item;
  });
  ipcMain.handle('lib:remove', (_e, id) => {
    const list = readJson(libIndex(), []);
    const item = list.find((i) => i.id === id);
    if (!item) return false;
    // only ever delete files that live inside the library folder
    if (path.dirname(item.file) === libDir()) { try { fs.unlinkSync(item.file); } catch {} }
    writeJson(libIndex(), list.filter((i) => i.id !== id));
    return true;
  });

  /* auto-saved project drafts: every project you work on is kept and listed on the home screen */
  const projDir = () => path.join(app.getPath('userData'), 'projects');
  const projIndex = () => path.join(projDir(), 'index.json');
  const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
  ipcMain.handle('proj:list', () => readJson(projIndex(), []).sort((a, b) => b.modified - a.modified));
  ipcMain.handle('proj:save', (_e, { id, name, json, thumb, duration, W, H }) => {
    if (!id) id = crypto.randomUUID();
    if (!safeId(id)) throw new Error('bad id');
    fs.mkdirSync(projDir(), { recursive: true });
    fs.writeFileSync(path.join(projDir(), id + '.freecut'), json, 'utf8');
    const list = readJson(projIndex(), []);
    const now = Date.now();
    const i = list.findIndex((p) => p.id === id);
    const meta = { id, name, thumb, duration, W, H, modified: now, created: i >= 0 ? list[i].created : now };
    if (i >= 0) list[i] = meta; else list.push(meta);
    writeJson(projIndex(), list);
    return id;
  });
  ipcMain.handle('proj:load', (_e, id) => {
    if (!safeId(id)) return null;
    try { return fs.readFileSync(path.join(projDir(), id + '.freecut'), 'utf8'); } catch { return null; }
  });
  ipcMain.handle('proj:delete', (_e, id) => {
    if (!safeId(id)) return false;
    try { fs.unlinkSync(path.join(projDir(), id + '.freecut')); } catch {}
    writeJson(projIndex(), readJson(projIndex(), []).filter((p) => p.id !== id));
    return true;
  });

  /* tiny JSON stores (presets) */
  ipcMain.handle('store:get', (_e, name) => (STORES.has(name) ? readJson(storeFile(name), null) : null));
  ipcMain.handle('store:set', (_e, name, data) => {
    if (!STORES.has(name)) return false;
    writeJson(storeFile(name), data);
    return true;
  });

  /* text to speech: Windows' built-in voices, generated offline into a WAV the editor drops on the timeline */
  const { execFile } = require('child_process');
  const ttsDir = () => path.join(app.getPath('userData'), 'tts');
  const ps = (args) => new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(String(stdout)))));
  let voiceCache = null;
  async function listVoices() {
    if (voiceCache) return voiceCache;
    const out = await ps(['-Command', "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }"]);
    voiceCache = out.split(/\r?\n/).filter(Boolean).map((l) => { const [name, culture] = l.split('|'); return { name, culture }; });
    return voiceCache;
  }
  const SPEAK_PS = [
    'param([string]$TextFile,[string]$Out,[string]$Voice,[int]$Rate)',
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'if ($Voice) { $s.SelectVoice($Voice) }',
    '$s.Rate = $Rate',
    '$s.SetOutputToWaveFile($Out)',
    '$s.Speak([IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8))',
    '$s.Dispose()'
  ].join('\r\n');
  ipcMain.handle('tts:voices', () => (process.platform === 'win32' ? listVoices().catch(() => []) : []));
  ipcMain.handle('tts:speak', async (_e, { text, voice, rate }) => {
    if (process.platform !== 'win32') throw new Error('Text to speech needs Windows');
    const body = String(text || '').trim().slice(0, 5000);
    if (!body) throw new Error('Type something to say first');
    const voices = await listVoices();
    const v = voices.find((x) => x.name === voice) ? voice : (voices[0] && voices[0].name) || '';
    fs.mkdirSync(ttsDir(), { recursive: true });
    const id = crypto.randomUUID(), txt = path.join(ttsDir(), id + '.txt'), out = path.join(ttsDir(), id + '.wav'), script = path.join(ttsDir(), 'speak.ps1');
    fs.writeFileSync(script, SPEAK_PS, 'utf8');
    fs.writeFileSync(txt, body, 'utf8');
    try {
      await ps(['-File', script, '-TextFile', txt, '-Out', out, '-Voice', v, '-Rate', String(Math.max(-10, Math.min(10, parseInt(rate, 10) || 0)))]);
    } finally { try { fs.unlinkSync(txt); } catch {} }
    if (!fs.existsSync(out)) throw new Error('No audio was produced');
    return { path: out };
  });

  /* reverse clip: the renderer encodes reversed frames/audio with WebCodecs and streams the chunks here to be muxed into a .webm */
  const revSessions = new Map();
  ipcMain.handle('rev:begin', (_e, o) => {
    const { Muxer, ArrayBufferTarget } = require('webm-muxer');
    const target = new ArrayBufferTarget();
    const cfg = { target, firstTimestampBehavior: 'offset' };
    if (o.video) cfg.video = { codec: o.video.codec === 'vp8' ? 'V_VP8' : 'V_VP9', width: o.video.w, height: o.video.h, frameRate: o.video.fps };
    if (o.audio) cfg.audio = { codec: 'A_OPUS', numberOfChannels: o.audio.channels, sampleRate: o.audio.sampleRate };
    const id = crypto.randomUUID();
    revSessions.set(id, { muxer: new Muxer(cfg), target });
    return id;
  });
  ipcMain.on('rev:video', (_e, id, ch) => { const s = revSessions.get(id); if (!s || s.failed) return; try { s.muxer.addVideoChunkRaw(new Uint8Array(ch.data), ch.type, ch.timestamp, ch.meta); } catch (err) { s.failed = String(err && err.message); } });
  ipcMain.on('rev:audio', (_e, id, ch) => { const s = revSessions.get(id); if (!s || s.failed) return; try { s.muxer.addAudioChunkRaw(new Uint8Array(ch.data), ch.type, ch.timestamp, ch.meta); } catch (err) { s.failed = String(err && err.message); } });
  ipcMain.handle('rev:finish', (_e, id) => {
    const s = revSessions.get(id);
    if (!s) throw new Error('Reverse session expired');
    if (s.failed) { revSessions.delete(id); throw new Error(s.failed); }
    s.muxer.finalize();
    const dir = path.join(app.getPath('userData'), 'reversed');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, id + '.webm');
    fs.writeFileSync(out, Buffer.from(s.target.buffer));
    revSessions.delete(id);
    return { path: out };
  });
  ipcMain.handle('rev:abort', (_e, id) => { revSessions.delete(id); return true; });

  /* installed fonts, so text can use anything on the PC (read from the Windows font registry) */
  let fontCache = null;
  ipcMain.handle('fonts:list', async () => {
    if (process.platform !== 'win32') return [];
    if (fontCache) return fontCache;
    try {
      const out = await ps(['-Command', "$ks='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'; foreach($k in $ks){ if(Test-Path $k){ (Get-Item $k).GetValueNames() } }"]);
      const skip = /wingdings|webdings|marlett|mdl2|symbol|fluent icons|emoji|bookshelf|holomdl/i;
      const style = /\s+(bold|italic|oblique|regular|light|semilight|semibold|medium|black|thin|condensed|narrow|extrabold|extralight|demi|heavy|book)\b.*$/i;
      const set = new Set();
      for (let n of out.split(/\r?\n/)) {
        n = n.replace(/\s*\((TrueType|OpenType|All res|VGA res)\)\s*$/i, '').trim();
        if (!n || n.includes('&') || skip.test(n)) continue;
        const fam = n.replace(style, '').trim() || n;
        if (fam && !skip.test(fam)) set.add(fam);
      }
      fontCache = [...set].sort((a, b) => a.localeCompare(b));
    } catch { fontCache = []; }
    return fontCache;
  });

  /* AI background removal: the renderer sends a downscaled frame, gets back a matte; mattes are kept in a side file, not in the project */
  const mattesDir = () => path.join(app.getPath('userData'), 'mattes');
  ipcMain.handle('bg:matte', async (e, { rgba, w, h, model, size }) => {
    const { matte } = require('./bgremove.js');
    return matte(rgba, w, h, {
      model,
      size,
      cacheDir: path.join(app.getPath('userData'), 'models'),
      onProgress: (p) => !e.sender.isDestroyed() && e.sender.send('bg:progress', { status: p.status, file: p.file, progress: p.progress })
    });
  });
  ipcMain.handle('bg:save', (_e, { data }) => {
    const id = crypto.randomUUID();
    fs.mkdirSync(mattesDir(), { recursive: true });
    fs.writeFileSync(path.join(mattesDir(), id + '.bin'), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return id;
  });
  ipcMain.handle('bg:load', (_e, id) => {
    if (!safeId(id)) return null;
    try { return fs.readFileSync(path.join(mattesDir(), id + '.bin')); } catch { return null; }
  });

  ipcMain.handle('captions:run', async (e, { audio, model, language }) => {
    const { transcribe } = require('./captions.js');
    const f32 = audio instanceof Float32Array ? audio : new Float32Array(audio.buffer || audio);
    return transcribe(f32, {
      model,
      language,
      cacheDir: path.join(app.getPath('userData'), 'models'),
      onProgress: (p) => !e.sender.isDestroyed() && e.sender.send('captions:progress', { status: p.status, file: p.file, progress: p.progress })
    });
  });

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
