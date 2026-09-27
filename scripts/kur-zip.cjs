const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kur-zip-'));
fs.mkdirSync(path.join(stage, 'assets'));
for (const f of ['Kur.bat', 'kur-gothic-1-lockpicker.ps1']) fs.copyFileSync(path.join(root, f), path.join(stage, f));
fs.copyFileSync(path.join(root, 'assets', 'icon.ico'), path.join(stage, 'assets', 'icon.ico'));
const out = path.join(root, 'release', 'Kur.zip');
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Force -Path '${path.join(stage, '*')}' -DestinationPath '${out}'`], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log('Kur.zip', fs.statSync(out).size);
