import { BrowserWindow, WebContentsView, type Rectangle } from 'electron';
import type { AgentActivityPhase } from '../../shared/contracts.js';

const html = `<!doctype html><html><head><title>Pilion Agent Shield</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
@property --phase{syntax:'<angle>';initial-value:0deg;inherits:false}
html,body{margin:0;width:100%;height:100%;overflow:hidden;user-select:none;cursor:not-allowed}
/* Phase palette: think=indigo, act=cyan, confirm=amber */
body{--hue:#4f7bff;--edge:#7aa2ff;--glow:#9cc0ff;--core:#eef4ff;--spin:6s;box-sizing:border-box;background:radial-gradient(130% 100% at 50% -20%,color-mix(in srgb,var(--hue) 9%,transparent),transparent 55%),radial-gradient(130% 100% at 50% 120%,color-mix(in srgb,var(--hue) 8%,transparent),transparent 55%);transition:background .5s}
body[data-phase=act]{--hue:#2fb9d6;--edge:#5fd6ff;--glow:#9ce8ff;--core:#eafbff;--spin:2.6s}
body[data-phase=confirm]{--hue:#e0a23a;--edge:#ffcf7a;--glow:#ffe0a8;--core:#fff5e6;--spin:6s}
.frame{position:absolute;inset:0;padding:1px;background:color-mix(in srgb,var(--edge) 32%,transparent);mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;transition:background .5s}
/* Orbiting sentinel: a bright head with a trailing arc, like a satellite sweeping the frame */
.sweep{position:absolute;inset:0;padding:2px;background:conic-gradient(from var(--phase),transparent 0deg,transparent 300deg,color-mix(in srgb,var(--glow) 0%,transparent) 312deg,color-mix(in srgb,var(--glow) 80%,transparent) 348deg,var(--core) 358deg,var(--core) 360deg);mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;filter:drop-shadow(0 0 6px var(--edge));animation:orbit var(--spin) linear infinite}
.atmosphere{position:absolute;inset:0;box-shadow:inset 0 0 34px color-mix(in srgb,var(--hue) 15%,transparent);animation:breathe 5s ease-in-out infinite alternate;transition:box-shadow .5s}
/* Corner reticles snap inward on activation, then hold */
.corner{position:absolute;width:16px;height:16px;border-color:var(--glow);border-style:solid;filter:drop-shadow(0 0 4px color-mix(in srgb,var(--hue) 70%,transparent));opacity:.9;animation:snap .5s cubic-bezier(.2,.9,.25,1) both;transition:border-color .5s}
.tl{top:7px;left:7px;border-width:1.5px 0 0 1.5px;--dx:-9px;--dy:-9px}
.tr{top:7px;right:7px;border-width:1.5px 1.5px 0 0;--dx:9px;--dy:-9px}
.bl{bottom:7px;left:7px;border-width:0 0 1.5px 1.5px;--dx:-9px;--dy:9px}
.br{bottom:7px;right:7px;border-width:0 1.5px 1.5px 0;--dx:9px;--dy:9px}
@keyframes orbit{to{--phase:360deg}}
@keyframes breathe{to{opacity:.5}}
@keyframes snap{0%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.7)}100%{opacity:.9;transform:translate(0,0) scale(1)}}
@media(prefers-reduced-motion:reduce){*,*:after,*:before{animation:none!important}}
</style></head><body data-phase="think" aria-hidden="true"><div class="atmosphere"></div><div class="frame"></div><div class="sweep"></div><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i></body></html>`;

/** Native input surface above all page views. Browser tools still target the underlying page. */
export class AgentShield {
  readonly view: WebContentsView;
  private active = false;
  private phase: AgentActivityPhase = 'think';
  private ready = false;

  constructor(private readonly parent: BrowserWindow) {
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view.setBackgroundColor('#00000000');
    this.view.setVisible(false);
    parent.contentView.addChildView(this.view);
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.view.webContents.on('will-navigate', (event) => event.preventDefault());
    this.view.webContents.on('before-input-event', (event) => event.preventDefault());
    this.view.webContents.once('did-finish-load', () => {
      this.ready = true;
      this.applyPhase();
    });
    void this.view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => undefined);
    parent.on('closed', () => {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    });
  }

  get locked(): boolean {
    return this.active;
  }

  update(
    active: boolean,
    bounds: Rectangle,
    visible: boolean,
    phase: AgentActivityPhase = 'think',
  ): void {
    if (this.parent.isDestroyed() || this.view.webContents.isDestroyed()) return;
    if (active && !this.active) this.parent.webContents.focus();
    this.active = active;
    if (phase !== this.phase) {
      this.phase = phase;
      this.applyPhase();
    }
    this.view.setBounds(bounds);
    if (active && visible) {
      // Re-adding an existing child brings it above newly opened page views.
      if (this.parent.contentView.children.at(-1) !== this.view)
        this.parent.contentView.addChildView(this.view);
      this.view.setVisible(true);
    } else {
      if (this.view.webContents.isFocused()) this.parent.webContents.focus();
      this.view.setVisible(false);
    }
  }

  private applyPhase(): void {
    if (!this.ready || this.view.webContents.isDestroyed()) return;
    const phase = this.phase;
    void this.view.webContents
      .executeJavaScript(`document.body.dataset.phase=${JSON.stringify(phase)}`)
      .catch(() => undefined);
  }
}
