import { BrowserWindow, systemPreferences, type WebContentsView } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';

type Point = { x: number; y: number };
const SIZE = 64;
const HOTSPOT = 24;
// A native, click-through child window stays above WebContentsView without injecting into pages.
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:64px;height:64px;overflow:hidden;background:transparent;pointer-events:none}
svg{position:absolute;left:24px;top:24px;width:26px;height:32px;filter:drop-shadow(0 0 4px #718dffa0) drop-shadow(0 2px 3px #171d4277)}
.aura{position:absolute;left:5px;top:5px;width:38px;height:38px;border-radius:50%;background:radial-gradient(circle,#c8d7ff44,#8c9aff22 40%,transparent 70%);animation:glow 2s ease-in-out infinite alternate}
.label{position:absolute;top:5px;left:37px;padding:2px 4px;border:1px solid #afc7ff88;border-radius:4px;background:#151a2deb;color:#ecf3ff;font:600 8px -apple-system,sans-serif;letter-spacing:.4px}
.ring{position:absolute;left:8px;top:8px;width:30px;height:30px;border:2px solid #a1baff;box-shadow:0 0 9px #7999ff66,inset 0 0 7px #9eb6ff44;border-radius:50%;opacity:0;transform-origin:center}
@keyframes glow{to{opacity:.5;transform:scale(.8)}}
@keyframes ripple{0%{opacity:.95;transform:scale(.25)}100%{opacity:0;transform:scale(1.3)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head><body><div class="aura"></div><div class="ring"></div><span class="label">AI</span><svg viewBox="0 0 26 32" aria-label="Agent 鼠标"><defs><linearGradient id="fill" x2="1" y2="1"><stop stop-color="#accdff"/><stop offset=".45" stop-color="#698bff"/><stop offset="1" stop-color="#aa83f6"/></linearGradient></defs><path d="M1 1L23 17L13 19L8 29Z" fill="url(#fill)" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg></body></html>`;

export class AgentPointer {
  private window?: BrowserWindow;
  private loading?: Promise<void>;
  private target?: WebContentsView;
  private point?: Point;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pulseStyle?: string;

  constructor(private readonly parent: BrowserWindow) {
    parent.on('move', () => this.place());
    parent.on('resize', () => this.hide());
    parent.on('blur', () => this.hide());
    parent.on('minimize', () => this.hide());
    parent.on('hide', () => this.hide());
    parent.on('closed', () => this.destroy());
  }

  private async ready(): Promise<BrowserWindow> {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        title: 'Pilion Agent Pointer',
        parent: this.parent,
        width: SIZE,
        height: SIZE,
        frame: false,
        transparent: true,
        hasShadow: false,
        show: false,
        focusable: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this.window.setIgnoreMouseEvents(true);
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.loading = this.window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      );
    }
    await this.loading;
    return this.window;
  }

  private place(): boolean {
    if (
      !this.window ||
      this.window.isDestroyed() ||
      !this.point ||
      !this.target ||
      this.target.webContents.isDestroyed() ||
      !this.target.getVisible() ||
      this.parent.isDestroyed() ||
      !this.parent.isVisible() ||
      this.parent.isMinimized()
    ) {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
      return false;
    }
    const frame = this.parent.getContentBounds();
    const view = this.target.getBounds();
    this.window.setBounds({
      x: Math.round(frame.x + view.x + this.point.x - HOTSPOT),
      y: Math.round(frame.y + view.y + this.point.y - HOTSPOT),
      width: SIZE,
      height: SIZE,
    });
    return true;
  }

  async move(
    view: WebContentsView,
    destination: Point,
    dispatch: (point: Point) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    const window = await this.ready();
    signal?.throwIfAborted();
    if (generation !== this.generation) throw new Error('鼠标操作已取消');
    const origin =
      this.target === view && this.point
        ? this.point
        : {
            x: Math.max(8, destination.x - 64),
            y: Math.max(8, destination.y - 32),
          };
    this.target = view;
    if (this.pulseStyle) await window.webContents.removeInsertedCSS(this.pulseStyle);
    this.pulseStyle = undefined;
    const steps = systemPreferences.getAnimationSettings().prefersReducedMotion ? 1 : 12;
    for (let step = 0; step <= steps; step += 1) {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new Error('鼠标操作已取消');
      const progress = 1 - (1 - step / steps) ** 3;
      this.point = {
        x: origin.x + (destination.x - origin.x) * progress,
        y: origin.y + (destination.y - origin.y) * progress,
      };
      if (this.place()) window.showInactive();
      await dispatch(this.point);
      if (step < steps) await delay(20, undefined, { signal });
    }
  }

  async click(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.pulseStyle) await this.window.webContents.removeInsertedCSS(this.pulseStyle);
    this.pulseStyle = await this.window.webContents.insertCSS(
      '.ring{animation:ripple 550ms ease-out}',
    );
  }

  settle(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), 700);
  }

  hideFor(view: WebContentsView): void {
    if (this.target === view) this.hide();
  }

  hide(): void {
    ++this.generation;
    clearTimeout(this.timer);
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    this.target = undefined;
    this.point = undefined;
  }

  destroy(): void {
    this.hide();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}
