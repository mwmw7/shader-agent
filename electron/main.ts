import { app, BrowserWindow, dialog, safeStorage, session } from 'electron';
import path from 'node:path';
import { startServer } from '../server/api.js';
let backend: Awaited<ReturnType<typeof startServer>> | undefined;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const win = BrowserWindow.getAllWindows()[0]; if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    const devUrl = process.env.UI_DEV_URL;
    if (devUrl && devUrl !== 'http://127.0.0.1:4200') throw new Error('허용되지 않은 개발 서버 주소');
    const canEncrypt = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    backend = await startServer({
      dataDir: process.env.HARNESS_DATA_DIR ?? app.getPath('userData'), port: devUrl ? 4317 : 0,
      uiDir: path.join(app.getAppPath(), 'dist-ui/browser'), devOrigin: devUrl,
      secretCodec: canEncrypt ? { encrypt: value => safeStorage.encryptString(value).toString('base64'), decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')) } : undefined,
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    const createWindow = async () => {
      const win = new BrowserWindow({ width: 1560, height: 1000, minWidth: 1024, minHeight: 720, title: 'Shader Harness Studio', backgroundColor: '#f4f7fb', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      const target = devUrl ?? backend!.url;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== target) event.preventDefault(); });
      await win.loadURL(target);
    };
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  }).catch(error => { dialog.showErrorBox('Shader Harness 시작 실패', String(error.message)); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !backend) return;
    event.preventDefault(); quitting = true;
    void backend.close().finally(() => app.quit());
  });
}
