const { app, BrowserWindow, ipcMain, globalShortcut, screen, desktopCapturer } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { runMacro, releaseAllKeys } = require('./macro.cjs');

let overlayWindow;
let isPanelOpen = false;
let isTargeting = false;
let macroChild = null;

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

// Bulletproof OS-level mouse polling
setInterval(() => {
  if (!overlayWindow) return;
  
  const point = screen.getCursorScreenPoint();
  const winBounds = overlayWindow.getBounds();
  const relX = point.x - winBounds.x;
  const relY = point.y - winBounds.y;
  
  let shouldCatch = false;
  
  if (isTargeting || isPanelOpen) {
    shouldCatch = true;
  } else {
    // Hamburger button hitbox: 100x100 top-left
    if (relX >= 0 && relX <= 100 && relY >= 0 && relY <= 100) {
      shouldCatch = true;
    }
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

  try {
    const { child } = runMacro(steps, { ...options, excludePid: process.pid }, {
      onStep: (index) => event.sender.send('macro-step', index),
      onFocus: (status) => event.sender.send('macro-focus', status),
      onFinished: (info) => {
        if (macroChild === child) macroChild = null;
        event.sender.send('macro-finished', info);
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

ipcMain.handle('get-desktop-source-id', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  if (sources.length > 0) {
    return sources[0].id; // Primary screen is usually first
  }
  return null;
});

app.whenReady().then(() => {
  createOverlayWindow();

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
