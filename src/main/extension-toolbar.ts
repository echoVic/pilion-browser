import { BrowserWindow, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron';
import {
  IPC,
  ExtensionToolbarActionSchema,
  type ExtensionToolbarAnchor,
  type ExtensionView,
} from '../shared/contracts.js';

/** A native child window paints above WebContentsView without hiding or resizing the page. */
export class ExtensionToolbar {
  private popup?: BrowserWindow;
  private dismissTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      parent(): BrowserWindow;
      preload: string;
      url(): string;
      items(): ExtensionView[];
      pin(id: string, pinned: boolean): Promise<void>;
      open(id: string): Promise<void>;
      manage(): void;
      noFocus: boolean;
    },
  ) {
    ipcMain.handle(IPC.extensionsToolbarItems, (event) => {
      this.trust(event);
      return this.options.items();
    });
    ipcMain.handle(IPC.extensionsToolbarAction, async (event, raw: unknown) => {
      this.trust(event);
      const value = ExtensionToolbarActionSchema.parse(raw);
      if (value.action === 'pin') await this.options.pin(value.id, value.pinned);
      else if (value.action === 'open') {
        await this.options.open(value.id);
        this.close();
      } else {
        if (value.action === 'manage') this.options.manage();
        this.close();
      }
    });
  }
  private trust(event: IpcMainInvokeEvent) {
    if (
      !this.popup ||
      this.popup.isDestroyed() ||
      event.sender !== this.popup.webContents ||
      event.senderFrame !== this.popup.webContents.mainFrame ||
      event.senderFrame.url !== this.options.url()
    )
      throw new Error('拒绝非可信扩展菜单');
  }
  close() {
    clearTimeout(this.dismissTimer);
    this.popup?.close();
  }
  async show(anchor: ExtensionToolbarAnchor) {
    if (this.popup && !this.popup.isDestroyed()) {
      this.close();
      return;
    }
    const parent = this.options.parent();
    const content = parent.getContentBounds();
    const work = screen.getDisplayMatching(parent.getBounds()).workArea;
    const width = Math.min(380, work.width);
    const height = Math.min(156 + Math.max(1, this.options.items().length) * 58, 620, work.height);
    const x = Math.round(
      Math.max(
        work.x,
        Math.min(content.x + anchor.x + anchor.width - width, work.x + work.width - width),
      ),
    );
    const y = Math.round(
      Math.max(
        work.y,
        Math.min(content.y + anchor.y + anchor.height + 6, work.y + work.height - height),
      ),
    );
    const popup = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      show: false,
      parent,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '扩展程序',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181c' : '#ffffff',
      webPreferences: {
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.popup = popup;
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    if (!this.options.noFocus)
      popup.on('blur', () => {
        // Give the parent toolbar click time to toggle this same popup closed.
        this.dismissTimer = setTimeout(() => {
          if (this.popup === popup) this.close();
        }, 150);
      });
    const close = () => popup.close();
    parent.on('move', close);
    parent.on('resize', close);
    popup.on('closed', () => {
      clearTimeout(this.dismissTimer);
      if (this.popup === popup) this.popup = undefined;
      parent.removeListener('move', close);
      parent.removeListener('resize', close);
    });
    try {
      await popup.loadURL(this.options.url());
      if (!popup.isDestroyed()) {
        if (this.options.noFocus) popup.showInactive();
        else popup.show();
      }
    } catch (error) {
      if (!popup.isDestroyed()) popup.close();
      throw error;
    }
  }
}
