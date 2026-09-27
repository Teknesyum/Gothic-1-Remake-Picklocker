const { app, ipcMain, net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'Teknesyum/Gothic-1-Remake-Picklocker';
const ASSET = 'Gothic1LockPicker-win-x64.zip';
const EXE = 'Gothic1LockPicker.exe';
const DAY = 24 * 60 * 60 * 1000;
const API = (process.env.G1LP_UPDATE_API || 'https://api.github.com').replace(/\/$/, '');
const DRY = process.env.G1LP_UPDATE_DRY === '1';

let state = null;
let release = null;
let zipPath = null;
let abort = null;
let installAfter = false;
let send = () => {};

function publish(next) {
  state = next ? { percent: 0, dryRun: DRY, ...next } : null;
  send(state);
}

function newer(latest, current) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function enabled() {
  return process.platform === 'win32' && (app.isPackaged || DRY);
}

async function getJson(url) {
  const res = await net.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Gothic1LockPicker' } });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return res.json();
}

async function check(manual) {
  if (!enabled()) return;
  if (state && (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'installing')) return;
  try {
    const body = await getJson(API + '/repos/' + REPO + '/releases/latest');
    const zip = (body.assets || []).find((a) => a.name === ASSET);
    const sum = (body.assets || []).find((a) => a.name === ASSET + '.sha256');
    if (!body.tag_name || !zip || !sum || !newer(body.tag_name, app.getVersion())) {
      release = null;
      publish(null);
      return;
    }
    release = { tag: body.tag_name, zip: zip.browser_download_url, sum: sum.browser_download_url, size: zip.size };
    publish({ phase: 'available', latest: body.tag_name.replace(/^v/, ''), notes: (body.body || '').trim() });
  } catch (err) {
    if (manual) publish({ phase: 'error', message: err.message });
    else console.error('Güncelleme denetimi başarısız:', err.message);
  }
}

async function fetchTo(url, file, signal, onChunk) {
  const res = await net.fetch(url, { signal, headers: { 'user-agent': 'Gothic1LockPicker' } });
  if (!res.ok) throw new Error('İndirilemedi: ' + res.status);
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      onChunk(value.length);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

async function download() {
  if (!release || !state || state.phase !== 'available') return;
  const rel = release;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1lp-update-'));
  const file = path.join(dir, ASSET);
  abort = new AbortController();
  let got = 0;
  let last = -1;
  publish({ ...state, phase: 'downloading', percent: 0 });
  try {
    await fetchTo(rel.zip, file, abort.signal, (n) => {
      got += n;
      const pct = rel.size ? Math.floor((got * 100) / rel.size) : 0;
      if (pct !== last) {
        last = pct;
        publish({ ...state, percent: pct });
      }
    });
    const sumFile = file + '.sha256';
    await fetchTo(rel.sum, sumFile, abort.signal, () => {});
    const want = (fs.readFileSync(sumFile, 'utf8').match(/\b[0-9a-fA-F]{64}\b/) || [''])[0].toLowerCase();
    const have = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (!want || want !== have) throw new Error('SHA-256 tutmuyor, dosya kurulmadı');
    abort = null;
    zipPath = file;
    publish({ ...state, phase: 'ready', percent: 100 });
    if (installAfter) install();
  } catch (err) {
    const cancelled = abort && abort.signal.aborted;
    abort = null;
    installAfter = false;
    fs.rmSync(dir, { recursive: true, force: true });
    if (cancelled) publish({ ...state, phase: 'available', percent: 0 });
    else publish({ ...state, phase: 'error', message: err.message });
  }
}

function helperScript() {
  return [
    'param([int]$Pid_, [string]$Zip, [string]$Dir, [string]$Exe, [int]$Dry)',
    '$ErrorActionPreference = "Stop"',
    '$new = $Dir + ".new"; $old = $Dir + ".old"; $swapped = $false',
    'function Retry([scriptblock]$Do) { for ($i = 0; $i -lt 40; $i++) { try { & $Do; return } catch { Start-Sleep -Milliseconds 500 } }; & $Do }',
    'try {',
    '  if ($Dry -ne 1) { try { Wait-Process -Id $Pid_ -Timeout 30 -ErrorAction SilentlyContinue } catch {} }',
    '  Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '  if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }',
    '  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $new)',
    '  if (-not (Test-Path -LiteralPath (Join-Path $new $Exe))) { throw ("missing " + $Exe) }',
    '  if (Test-Path -LiteralPath $old) { Retry { Remove-Item -LiteralPath $old -Recurse -Force } }',
    '  Retry { Rename-Item -LiteralPath $Dir -NewName (Split-Path -Leaf $old) }',
    '  try { Retry { Rename-Item -LiteralPath $new -NewName (Split-Path -Leaf $Dir) } } catch { Rename-Item -LiteralPath $old -NewName (Split-Path -Leaf $Dir); throw }',
    '  $swapped = $true',
    '} catch {',
    '  Write-Output ("FAIL:" + $_.Exception.Message)',
    '}',
    'if ($Dry -eq 1) { if ($swapped) { Remove-Item -LiteralPath $old -Recurse -Force; Write-Output "DRY:ok"; exit 0 } else { exit 1 } }',
    'Start-Process -FilePath (Join-Path $Dir $Exe) -WorkingDirectory $Dir',
    'if ($swapped) { Start-Sleep -Seconds 3; Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }',
    'Remove-Item -LiteralPath (Split-Path -Parent $Zip) -Recurse -Force -ErrorAction SilentlyContinue',
  ].join('\r\n');
}

function install() {
  if (!zipPath || !state || state.phase !== 'ready') return;
  installAfter = false;
  publish({ ...state, phase: 'installing', percent: 100 });
  const script = path.join(path.dirname(zipPath), 'yukle.ps1');
  fs.writeFileSync(script, '﻿' + helperScript(), 'utf8');
  const dir = DRY ? path.join(path.dirname(zipPath), 'prova') : path.dirname(process.execPath);
  if (DRY) fs.mkdirSync(dir, { recursive: true });
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, '-Pid_', String(process.pid), '-Zip', zipPath, '-Dir', dir, '-Exe', EXE, '-Dry', DRY ? '1' : '0'],
    { detached: !DRY, windowsHide: true, stdio: DRY ? 'pipe' : 'ignore' },
  );
  if (DRY) {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => publish({ ...state, phase: code === 0 ? 'ready' : 'error', message: out.trim() }));
    return;
  }
  child.unref();
  app.quit();
}

function attachUpdater(win) {
  send = (s) => {
    if (!win.isDestroyed()) win.webContents.send('update-state', s);
  };
  ipcMain.handle('update-get', () => state);
  ipcMain.on('update-check', () => {
    if (state && state.phase === 'error') publish(null);
    check(true);
  });
  ipcMain.on('update-download', (_e, andInstall) => {
    installAfter = andInstall === true;
    download();
  });
  ipcMain.on('update-cancel', () => {
    if (abort) abort.abort();
  });
  ipcMain.on('update-install', () => install());
  if (!enabled()) return;
  setTimeout(() => check(false), 8000);
  setInterval(() => check(false), DAY);
}

module.exports = { attachUpdater, newer };
