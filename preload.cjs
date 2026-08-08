const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopSourceId: () => ipcRenderer.invoke('get-desktop-source-id'),
  setOverlayInteractive: (enabled) => ipcRenderer.send('overlay:set-interactive', enabled),
  setPanelState: (isOpen) => ipcRenderer.send('set-panel-state', isOpen),
  setTargetingState: (targeting) => ipcRenderer.send('set-targeting-state', targeting),
  executeMacro: (steps, delay) => ipcRenderer.send('execute-macro', steps, delay),
  onMacroStep: (callback) => {
    const handler = (_event: any, stepIndex: number) => callback(stepIndex);
    ipcRenderer.on('macro-step', handler);
    return () => ipcRenderer.removeListener('macro-step', handler);
  },
  onMacroFinished: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('macro-finished', handler);
    return () => ipcRenderer.removeListener('macro-finished', handler);
  },
  onTogglePanel: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('overlay:toggle', handler);
    return () => ipcRenderer.removeListener('overlay:toggle', handler);
  }
});
