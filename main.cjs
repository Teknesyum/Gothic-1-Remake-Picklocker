const { app, BrowserWindow, ipcMain, globalShortcut, screen, desktopCapturer } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let overlayWindow;
let clickRegions = [];
let isPanelOpen = false;
let isTargeting = false;

function createOverlayWindow() {
  if (overlayWindow) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width,
    height,
    transparent: true,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: true,
      contextIsolation: true,
      webSecurity: false
    }
  });

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


function updateMousePolicy() {
  // Driven by interval now
}

ipcMain.on('overlay:set-interactive', (event, enabled) => {
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

ipcMain.on('execute-macro', (event, steps, delay = 300) => {
  let psScript = 'Add-Type -AssemblyName System.Windows.Forms;\n';
  steps.forEach((step, index) => {
    psScript += `Write-Host "STEP:${index}";\n`;
    let sendKey = step.key.toLowerCase();
    psScript += `[System.Windows.Forms.SendKeys]::SendWait("{${sendKey}}");\n`;
    psScript += `Start-Sleep -Milliseconds ${delay};\n`;
  });
  
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
  
  child.stdout.on('data', (data) => {
    const output = data.toString();
    const match = output.match(/STEP:(\d+)/);
    if (match) {
      event.sender.send('macro-step', parseInt(match[1], 10));
    }
  });

  child.on('close', () => {
    event.sender.send('macro-finished');
  });
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
