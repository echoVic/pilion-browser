import { BrowserWindow } from 'electron';
import { showWindow } from './window-focus.js';

/**
 * 独立悬浮 Agent 窗口（Chrome Gemini 插件同款体验）：
 * 设 parent 跟随主窗口置顶于真实 WebContentsView 网页之上、可自由拖拽与缩放；
 * 关掉时仅隐藏，再次呼出保留位置与尺寸；主窗口退出或关闭时由主进程销毁。
 */
export function createAgentWindow(options: {
  parent: BrowserWindow;
  preload: string;
  load(window: BrowserWindow): Promise<void>;
  quitting(): boolean;
  onHide(): void;
}): BrowserWindow {
  const parentBounds = options.parent.getBounds();
  const width = 396;
  const height = Math.min(640, Math.max(480, parentBounds.height - 96));
  const x = Math.round(parentBounds.x + Math.max(24, parentBounds.width - width - 24));
  const y = Math.round(parentBounds.y + 44);

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 320,
    minHeight: 420,
    maxWidth: 640,
    show: false,
    parent: options.parent,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Pilion Agent',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('close', (event) => {
    if (options.quitting()) return;
    event.preventDefault();
    win.hide();
    options.onHide();
  });
  win.once('ready-to-show', () => showWindow(win));
  void options.load(win).catch((error) => console.error('悬浮 Agent 窗口加载失败', error));
  return win;
}
