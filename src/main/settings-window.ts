import { BrowserWindow } from 'electron';

/**
 * 设置窗口第一次打开时才创建，关掉只是藏起来，再开时原样显示。
 * 不设 parent：macOS 上子窗口会跟着主窗口一起移动、一起最小化。
 */
export function createSettingsWindow(options: {
  preload: string;
  dark: boolean;
  load(window: BrowserWindow): Promise<void>;
  /** 应用退出时必须放行，否则这里拦下的 close 会让 ⌘Q 整个作废。 */
  quitting(): boolean;
}): BrowserWindow {
  const window = new BrowserWindow({
    width: 820,
    height: 620,
    minWidth: 680,
    minHeight: 480,
    show: false,
    title: 'Pilion 设置',
    fullscreenable: false,
    backgroundColor: options.dark ? '#17181c' : '#f1f2f4',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 19 } }
      : {}),
    webPreferences: {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (options.quitting()) return;
    event.preventDefault();
    window.hide();
  });
  window.once('ready-to-show', () => window.show());
  void options.load(window).catch((error) => console.error('设置窗口加载失败', error));
  return window;
}
