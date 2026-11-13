import { BrowserWindow, systemPreferences, type WebContentsView } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';

type Point = { x: number; y: number };
const SIZE = 64;
/** Minimum time a pointer move occupies, including the rest on the target when motion is reduced. */
const MOVE_DURATION_MS = 240;
const HOTSPOT = 24;
/** How long the overlay stays on a view after that view's last action. */
const SETTLE_MS = 700;
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

/**
 * Pointer state for one view. Agents can work in several tabs at once, so cancelling and settling
 * are per view: one tab's move, cancel or settle timer never touches another tab's action.
 */
interface ViewState {
  /** Bumped by a newer move on this view or by cancelFor; an in-flight move that sees it change stops. */
  generation: number;
  /** Where the pointer last was on this view, in view coordinates. */
  point?: Point;
  /** Hides the overlay a while after this view's last action. */
  timer?: ReturnType<typeof setTimeout>;
}

export class AgentPointer {
  private window?: BrowserWindow;
  private loading?: Promise<void>;
  /** The view the overlay is drawn over. Only a view that can be drawn (see drawable) becomes it. */
  private target?: WebContentsView;
  private readonly views = new Map<WebContentsView, ViewState>();
  private pulseStyle?: string;

  /** allowed 为 false 时不画指针，操作照常进行：静默模式下不能浮到别的应用上面。 */
  constructor(
    private readonly parent: BrowserWindow,
    private readonly allowed: () => boolean = () => true,
    /**
     * 仅当目标 view 是用户正在看的活动标签时才画指针。Agent 在后台标签干活时，
     * CDP mouseMoved 派发与停留照常，但不浮出可见光标（用户在看别的页）。
     */
    private readonly onForeground: (view: WebContentsView) => boolean = () => true,
  ) {
    parent.on('move', () => this.place());
    // Window-level visibility changes only conceal the overlay. The agent's input keeps flowing, so a
    // click does not fail because the user switched apps; the overlay returns on the next step.
    parent.on('resize', () => this.conceal());
    parent.on('blur', () => this.conceal());
    parent.on('minimize', () => this.conceal());
    parent.on('hide', () => this.conceal());
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

  private state(view: WebContentsView): ViewState {
    let state = this.views.get(view);
    if (!state) {
      state = { generation: 0 };
      this.views.set(view, state);
    }
    return state;
  }

  /** Whether the overlay may be drawn over this view right now. */
  private drawable(view: WebContentsView): boolean {
    return (
      !view.webContents.isDestroyed() &&
      view.getVisible() &&
      !this.parent.isDestroyed() &&
      this.parent.isVisible() &&
      !this.parent.isMinimized() &&
      this.allowed() &&
      this.onForeground(view)
    );
  }

  private place(): boolean {
    const view = this.target;
    const point = view && this.views.get(view)?.point;
    if (!this.window || this.window.isDestroyed() || !view || !point || !this.drawable(view)) {
      this.conceal();
      return false;
    }
    const frame = this.parent.getContentBounds();
    const bounds = view.getBounds();
    this.window.setBounds({
      x: Math.round(frame.x + bounds.x + point.x - HOTSPOT),
      y: Math.round(frame.y + bounds.y + point.y - HOTSPOT),
      width: SIZE,
      height: SIZE,
    });
    return true;
  }

  /**
   * Shows this view's step. A view that cannot be drawn (a background tab, say) leaves the overlay
   * alone unless the overlay is its own, so it never hides the pointer of the tab the user watches.
   */
  private draw(view: WebContentsView, window: BrowserWindow): void {
    if (this.drawable(view)) {
      this.target = view;
      if (this.place()) window.showInactive();
    } else if (this.target === view) this.conceal();
  }

  async move(
    view: WebContentsView,
    destination: Point,
    dispatch: (point: Point) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.state(view);
    const generation = ++state.generation;
    const cancelled = () => generation !== state.generation;
    clearTimeout(state.timer);
    const window = await this.ready();
    signal?.throwIfAborted();
    if (cancelled()) throw new Error('鼠标操作已取消');
    const origin = state.point ?? {
      x: Math.max(8, destination.x - 64),
      y: Math.max(8, destination.y - 32),
    };
    if (this.pulseStyle) await window.webContents.removeInsertedCSS(this.pulseStyle);
    this.pulseStyle = undefined;
    const steps = systemPreferences.getAnimationSettings().prefersReducedMotion ? 1 : 12;
    const started = Date.now();
    for (let step = 0; step <= steps; step += 1) {
      signal?.throwIfAborted();
      if (cancelled()) throw new Error('鼠标操作已取消');
      const progress = 1 - (1 - step / steps) ** 3;
      const point = {
        x: origin.x + (destination.x - origin.x) * progress,
        y: origin.y + (destination.y - origin.y) * progress,
      };
      state.point = point;
      this.draw(view, window);
      await dispatch(point);
      if (step < steps) await delay(20, undefined, { signal });
    }
    // Without motion the pointer would act the instant it appears. Rest on the target for as long as
    // the animation would have taken, so the visible cursor stays perceivable and takeover remains possible.
    const remaining = MOVE_DURATION_MS - (Date.now() - started);
    if (remaining > 0) {
      await delay(remaining, undefined, { signal });
      signal?.throwIfAborted();
      if (cancelled()) throw new Error('鼠标操作已取消');
    }
  }

  /** Ripples the overlay for a click on this view; a click in a tab the overlay is not drawn over shows nothing. */
  async click(view: WebContentsView): Promise<void> {
    if (!this.window || this.window.isDestroyed() || this.target !== view) return;
    if (this.pulseStyle) await this.window.webContents.removeInsertedCSS(this.pulseStyle);
    this.pulseStyle = await this.window.webContents.insertCSS(
      '.ring{animation:ripple 550ms ease-out}',
    );
  }

  /** Hides the overlay a while after this view's last action. Work on other views neither delays nor triggers it. */
  settle(view: WebContentsView): void {
    const state = this.views.get(view);
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.point = undefined;
      if (this.target === view) {
        this.target = undefined;
        this.conceal();
      }
    }, SETTLE_MS);
  }

  /**
   * The view stopped being visible (main.ts layout()). Visibility only conceals the overlay: the
   * agent's input in that view keeps flowing, and the overlay returns on the next step it can be drawn.
   */
  hideFor(view: WebContentsView): void {
    if (this.target === view) this.conceal();
  }

  /** This view's page changed or closed, or its action was cancelled: stop its in-flight pointer action. */
  cancelFor(view: WebContentsView): void {
    const state = this.views.get(view);
    if (state) {
      state.generation += 1;
      clearTimeout(state.timer);
      this.views.delete(view);
    }
    if (this.target === view) {
      this.target = undefined;
      this.conceal();
    }
  }

  private conceal(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  /** Cancels every view's in-flight pointer action and hides the overlay. */
  hide(): void {
    for (const view of [...this.views.keys()]) this.cancelFor(view);
    this.target = undefined;
    this.conceal();
  }

  destroy(): void {
    this.hide();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}
