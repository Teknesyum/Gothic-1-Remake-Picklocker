const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopSourceId: () => ipcRenderer.invoke('get-desktop-source-id'),
  setOverlayInteractive: (enabled) => ipcRenderer.send('overlay:set-interactive', enabled),
  setPanelState: (isOpen) => ipcRenderer.send('set-panel-state', isOpen),
  setTargetingState: (targeting) => ipcRenderer.send('set-targeting-state', targeting),
  setButtonVisible: (visible) => ipcRenderer.send('set-button-visible', visible),
  executeMacro: (steps, options) => ipcRenderer.send('execute-macro', steps, options),
  cancelMacro: () => ipcRenderer.send('cancel-macro'),
  startFocusGuard: () => ipcRenderer.send('start-focus-guard'),
  stopFocusGuard: () => ipcRenderer.send('stop-focus-guard'),
  quitApp: () => ipcRenderer.send('quit-app'),
  onMacroStep: (callback) => {
    const handler = (_event, stepIndex) => callback(stepIndex);
    ipcRenderer.on('macro-step', handler);
    return () => ipcRenderer.removeListener('macro-step', handler);
  },
  onMacroFinished: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('macro-finished', handler);
    return () => ipcRenderer.removeListener('macro-finished', handler);
  },
  onMacroFocus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('macro-focus', handler);
    return () => ipcRenderer.removeListener('macro-focus', handler);
  },
  onMacroAbort: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('macro-abort', handler);
    return () => ipcRenderer.removeListener('macro-abort', handler);
  },
  onTogglePanel: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('overlay:toggle', handler);
    return () => ipcRenderer.removeListener('overlay:toggle', handler);
  },
  onCornerHover: (callback) => {
    const handler = (_event, isOver) => callback(isOver);
    ipcRenderer.on('corner-hover', handler);
    return () => ipcRenderer.removeListener('corner-hover', handler);
  }
});
