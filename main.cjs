const { app, BrowserWindow, ipcMain, globalShortcut, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const { runMacro, releaseAllKeys, runFocusGuard } = require('./macro.cjs');

const execAsync = promisify(exec);

let overlayWindow;
let isPanelOpen = false;
let isTargeting = false;
let isButtonVisible = true;
let macroChild = null;
let focusGuardChild = null;
// Bekçinin en son gördüğü, overlay dışındaki ön plan penceresi (muhtemelen
// oyun). Bekçi kapansa bile (ör. makro başlarken) burada kalıyor ki makro
// aynı pencereyi hedefleyebilsin. Bkz. macro.cjs: buildFocusGuardScript.
let lastKnownGameHwnd = null;

/** Overlay'in native HWND'sini PowerShell'e geçirilebilecek hex string olarak döner. */
function getOverlayHwndHex() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  const buf = overlayWindow.getNativeWindowHandle();
  const value = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  return '0x' + value.toString(16);
}

function createOverlayWindow() {
  if (overlayWindow) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  // bounds (not workAreaSize): the overlay must also cover the taskbar strip,
  // otherwise a lock UI rendered under the taskbar has a dead zone.
  const { x, y, width, height } = primaryDisplay.bounds;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    // Deliberately NOT `fullscreen: true`. Windows only lets one real
    // fullscreen surface own the screen at a time; a second fullscreen
    // window (ours) fighting the game for that slot is what caused the
    // overlay/game to intermittently minimize or the panel to appear
    // "closed" after alt-tabbing. A borderless window sized to the full
    // display avoids entering that OS-level fullscreen state entirely.
    fullscreen: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    // Panele mouse ile tıklamak (plaka/vektör ayarlarını değiştirmek gibi)
    // pencereyi Windows'a "aktif" olarak bildirmemeli. Odaklanabilir bir
    // pencere tıklandığında OS klavye girdisini ona yönlendirir — bu da W/A/S/D
    // gibi tuşları oyuna hiç ulaştırmadan yutuyordu. focusable:false ile
    // pencere mouse tıklamalarını yine alır (setIgnoreMouseEvents ile
    // yönetiliyor) ama hiçbir zaman klavye odağını çalmaz, dolayısıyla
    // panel açıkken bile fiziksel klavye oyuna gitmeye devam eder.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false
    }
  });

  // Plain alwaysOnTop (default 'floating' level) still loses to other
  // topmost/fullscreen windows. 'screen-saver' is the highest z-order
  // Windows exposes and is what keeps overlays above exclusive-mode apps.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Make it ignore mouse events initially except when we explicitly want clicks
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  if (process.env.NODE_ENV === 'development') {
    overlayWindow.loadURL('http://127.0.0.1:5173');
  } else {
    overlayWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}


ipcMain.on('overlay:set-interactive', () => {
  // Still keep this for compatibility, but the interval handles real logic
});

ipcMain.on('set-panel-state', (event, isOpen) => {
  isPanelOpen = isOpen;
});

ipcMain.on('set-targeting-state', (event, targeting) => {
  isTargeting = targeting;
});

ipcMain.on('set-button-visible', (event, visible) => {
  isButtonVisible = visible;
});

// Panelin görsel konumu App.tsx'teki slide-out panel div'inin Tailwind
// sınıflarıyla (top-20 left-4 bottom-4 w-[450px], 1rem=16px varsayımıyla)
// BİREBİR eşleşmeli. Bu sınıflar değişirse burası da güncellenmeli —
// aksi halde panel ile tıklama hitbox'ı birbirinden kayar.
const PANEL_LEFT = 16;
const PANEL_TOP = 80;
const PANEL_WIDTH = 450;
const PANEL_BOTTOM_MARGIN = 16;

// Pasif Mod: köşe butonu simgesiz/görünmez dururken farenin butonun
// bulunduğu 100x100 bölgeye girip girmediğini render'dan bağımsız olarak
// bilmemiz gerekiyor (buton zaten görünmezken normal hit-testing bunu
// yakalamaz). `screen.getCursorScreenPoint()` pencere click-through/pass
// through modundayken bile çalışır, bu yüzden ayrı bir algılamaya gerek yok
// — sadece bu bilgiyi renderer'a bildiriyoruz.
let wasOverButtonCorner = false;

// Bulletproof OS-level mouse polling
setInterval(() => {
  if (!overlayWindow) return;

  const point = screen.getCursorScreenPoint();
  const winBounds = overlayWindow.getBounds();
  const relX = point.x - winBounds.x;
  const relY = point.y - winBounds.y;

  const overButtonCorner = relX >= 0 && relX <= 100 && relY >= 0 && relY <= 100;
  if (overButtonCorner !== wasOverButtonCorner) {
    wasOverButtonCorner = overButtonCorner;
    overlayWindow.webContents.send('corner-hover', overButtonCorner);
  }

  let shouldCatch = false;

  if (isTargeting) {
    // Hedefleme sırasında köşe şablonu her yerden seçilebilmeli.
    shouldCatch = true;
  } else {
    // Hamburger button hitbox: 100x100 top-left. Only catch here while the
    // button is actually rendered — otherwise this square is an invisible
    // dead zone the player can't click through to the game underneath.
    const inButtonHitbox = isButtonVisible &&
      relX >= 0 && relX <= 100 && relY >= 0 && relY <= 100;

    // Panel açıkken SADECE panelin görsel dikdörtgenini yakala — eskiden
    // bu blok isPanelOpen olduğunda tüm pencereyi (ekranı) tıklanabilir
    // yapıyordu, bu yüzden oyunun görünür olduğu sağ tarafa yapılan
    // tıklamalar oyuna hiç ulaşmadan şeffaf overlay tarafından yutuluyordu.
    const panelHeight = winBounds.height - PANEL_TOP - PANEL_BOTTOM_MARGIN;
    const inPanelHitbox = isPanelOpen &&
      relX >= PANEL_LEFT && relX <= PANEL_LEFT + PANEL_WIDTH &&
      relY >= PANEL_TOP && relY <= PANEL_TOP + panelHeight;

    shouldCatch = inButtonHitbox || inPanelHitbox;
  }

  if (shouldCatch) {
    if (!overlayWindow.isCatching) {
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.isCatching = true;
    }
  } else {
    if (overlayWindow.isCatching !== false) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.isCatching = false;
    }
  }
}, 30);

function stopMacro(reason) {
  if (!macroChild) return false;
  const child = macroChild;
  macroChild = null;
  // PowerShell alt süreçleriyle birlikte öldür; sonra basılı kalmış
  // olabilecek tuşları serbest bırak.
  spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
  releaseAllKeys();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('macro-finished', { ok: false, cancelled: true, error: reason });
  }
  return true;
}

ipcMain.on('execute-macro', (event, steps, options = {}) => {
  if (macroChild) {
    event.sender.send('macro-finished', { ok: false, error: 'Zaten çalışan bir makro var.' });
    return;
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    event.sender.send('macro-finished', { ok: false, error: 'Gönderilecek adım yok.' });
    return;
  }

  // Overlay odağı bırakmazsa tuşlar oyuna değil bize gider.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.blur();
  }

  // Bekçi de aynı ALT-tap + SetForegroundWindow numarasını kullanıyor;
  // makro ile aynı anda koşarsa fiziksel ALT tuşu iki süreçten üst üste
  // gönderilip zamanlamayı bozabilir. Makro kendi odak mantığını zaten
  // yürütüyor, bekçiye burada gerek yok.
  stopFocusGuard();

  try {
    const { child } = runMacro(steps, { ...options, excludePid: process.pid, knownHwnd: lastKnownGameHwnd }, {
      onStep: (index) => event.sender.send('macro-step', index),
      onFocus: (status) => event.sender.send('macro-focus', status),
      onFinished: (info) => {
        // stopMacro() (Durdur/Alt+X) zaten macroChild'ı null'layıp kendi
        // 'macro-finished' mesajını göndermiş olabilir; bu durumda süreç
        // taskkill ile öldürüldüğü için burada ayrıca sıfır olmayan bir çıkış
        // koduyla İKİNCİ bir (yanlış "PowerShell çıkış kodu 1" hatası veren)
        // mesaj göndermemeliyiz — sadece süreç hâlâ "aktif" makro sayılıyorsa gönder.
        const wasActive = macroChild === child;
        if (wasActive) {
          macroChild = null;
          event.sender.send('macro-finished', info);
        }
      }
    });
    macroChild = child;
  } catch (err) {
    event.sender.send('macro-finished', { ok: false, error: err.message });
  }
});

ipcMain.on('cancel-macro', () => {
  stopMacro('Kullanıcı tarafından durduruldu.');
});

function stopFocusGuard() {
  if (!focusGuardChild) return;
  const child = focusGuardChild;
  focusGuardChild = null;
  spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
}

// Panel açıkken (ve makro/hedefleme sürmüyorken) oyunun ön plan durumunu
// sürekli geri kazandıran bekçi süreci. Bkz. macro.cjs: buildFocusGuardScript.
ipcMain.on('start-focus-guard', () => {
  if (focusGuardChild) return;
  focusGuardChild = runFocusGuard(
    { excludePid: process.pid, ourHwnd: getOverlayHwndHex() },
    { onLastForeground: (hwndHex) => { lastKnownGameHwnd = hwndHex; } }
  );
});

ipcMain.on('stop-focus-guard', stopFocusGuard);

ipcMain.on('quit-app', () => {
  app.quit();
});

ipcMain.handle('get-desktop-source-id', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  if (sources.length > 0) {
    return sources[0].id; // Primary screen is usually first
  }
  return null;
});

/**
 * Her açılışta git tabanlı güncelleme kontrolü. Paketlenmiş (asar) sürümde
 * `.git` dizini bulunmadığı için sessizce atlanır — bu yalnızca install.ps1
 * ile git-clone edilen geliştirme kurulumları için çalışır (uygulamanın
 * fiilen kullanıldığı yöntem: `npm run electron:dev`).
 *
 * Kullanıcı "Şimdi Değil" derse hiçbir şey yapmadan mevcut (eski) sürümle
 * devam edilir. "Güncelle" derse `git reset --hard origin/master` + `npm
 * install` çalıştırılıp uygulama yeniden başlatılır.
 */
async function checkForUpdates() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) return;

  try {
    const local = (await execAsync('git rev-parse HEAD', { cwd: __dirname })).stdout.trim();
    await execAsync('git fetch origin master --quiet', { cwd: __dirname, timeout: 10000 });
    const remote = (await execAsync('git rev-parse origin/master', { cwd: __dirname })).stdout.trim();

    if (local === remote) return; // güncel

    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Güncelle ve Yeniden Başlat', 'Şimdi Değil'],
      defaultId: 0,
      cancelId: 1,
      title: 'Güncelleme Mevcut',
      message: 'Gothic 1 LockPicker için yeni bir sürüm mevcut.',
      detail: 'Şimdi güncellensin mi? Uygulama yeniden başlatılacak.'
    });

    if (response !== 0) return; // "Şimdi Değil" -> eski sürümle devam

    await execAsync('git reset --hard origin/master', { cwd: __dirname });
    await execAsync('npm install', { cwd: __dirname, timeout: 300000 });

    app.relaunch();
    app.exit(0);
  } catch (err) {
    // Git yok, internet yok, fetch başarısız, vs. — sessizce eski sürümle devam.
    console.error('Güncelleme kontrolü başarısız:', err.message);
  }
}

app.whenReady().then(() => {
  createOverlayWindow();
  checkForUpdates();

  // Bind multiple hotkeys in case the game blocks one
  const toggleFn = () => {
    if (overlayWindow) overlayWindow.webContents.send('overlay:toggle');
  };
  globalShortcut.register('F9', toggleFn);
  globalShortcut.register('F10', toggleFn);
  globalShortcut.register('CommandOrControl+Space', toggleFn);
  globalShortcut.register('Alt+Z', toggleFn);

  // Acil durdurma: makro yanlış gidiyorsa oyuna dokunmadan kesebilmek gerek.
  const abortFn = () => {
    if (stopMacro('Acil durdurma (Alt+X).') && overlayWindow) {
      overlayWindow.webContents.send('macro-abort');
    }
  };
  globalShortcut.register('Alt+X', abortFn);
  globalShortcut.register('F8', abortFn);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Çıkarken makro çalışıyorsa tuşlar basılı kalmasın.
  stopMacro('Uygulama kapatıldı.');
  stopFocusGuard();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
