import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const overlays: FakeOverlay[] = [];
class FakeOverlay {
  readonly shown: boolean[] = [];
  readonly webContents = {
    setWindowOpenHandler: () => undefined,
    insertCSS: async () => 'pulse',
    removeInsertedCSS: async () => undefined,
  };
  constructor() {
    overlays.push(this);
  }
  setIgnoreMouseEvents(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return false;
  }
  setBounds(): void {}
  showInactive(): void {
    this.shown.push(true);
  }
  hide(): void {
    this.shown.push(false);
  }
  destroy(): void {}
}

vi.mock('electron', () => ({
  BrowserWindow: FakeOverlay,
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) },
}));

const { AgentPointer } = await import('../src/main/browser/agent-pointer');

function parentWindow(): BrowserWindow {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  }) as unknown as BrowserWindow;
}

function view(visible = true): WebContentsView & { visible: boolean } {
  const result = {
    visible,
    webContents: { isDestroyed: () => false },
    getVisible: () => result.visible,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  };
  return result as unknown as WebContentsView & { visible: boolean };
}

/** A move whose first dispatched step waits until release() is called. */
function heldMove(pointer: InstanceType<typeof AgentPointer>, target: WebContentsView) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const atFirstStep = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let first = true;
  const done = pointer.move(target, { x: 200, y: 200 }, async () => {
    if (!first) return;
    first = false;
    reached();
    await gate;
  });
  done.catch(() => undefined);
  return { done, atFirstStep, release };
}

const quickMove = (pointer: InstanceType<typeof AgentPointer>, target: WebContentsView) =>
  pointer.move(target, { x: 50, y: 50 }, async () => undefined);

describe('AgentPointer scopes cancellation to the view that owns the action', () => {
  it("does not cancel one tab's click because another tab's agent moved", async () => {
    const pointer = new AgentPointer(parentWindow());
    const [a, b] = [view(), view()];
    const first = heldMove(pointer, a);
    await first.atFirstStep;
    await quickMove(pointer, b);
    first.release();
    await expect(first.done).resolves.toBeUndefined();
  });

  it('does not fail input when the view is hidden: hiding only conceals the overlay', async () => {
    const pointer = new AgentPointer(parentWindow());
    const a = view();
    const held = heldMove(pointer, a);
    await held.atFirstStep;
    // What main.ts layout() does for a view that is no longer visible.
    a.visible = false;
    pointer.hideFor(a);
    expect(overlays.at(-1)!.shown.at(-1)).toBe(false);
    held.release();
    await expect(held.done).resolves.toBeUndefined();
  });

  it("does not let another tab's settle timer cancel this tab's work", async () => {
    const pointer = new AgentPointer(parentWindow());
    const [a, b] = [view(), view()];
    await quickMove(pointer, a);
    const held = heldMove(pointer, b);
    await held.atFirstStep;
    pointer.settle(a);
    await new Promise((resolve) => setTimeout(resolve, 800));
    held.release();
    await expect(held.done).resolves.toBeUndefined();
  });

  it('still cancels the action of a view whose page changed, and only that one', async () => {
    const pointer = new AgentPointer(parentWindow());
    const [a, b] = [view(), view()];
    const onA = heldMove(pointer, a);
    const onB = heldMove(pointer, b);
    await Promise.all([onA.atFirstStep, onB.atFirstStep]);
    pointer.cancelFor(a);
    onA.release();
    onB.release();
    await expect(onA.done).rejects.toThrow('鼠标操作已取消');
    await expect(onB.done).resolves.toBeUndefined();
  });

  it('a newer move on the same view still supersedes the older one', async () => {
    const pointer = new AgentPointer(parentWindow());
    const a = view();
    const older = heldMove(pointer, a);
    await older.atFirstStep;
    await quickMove(pointer, a);
    older.release();
    await expect(older.done).rejects.toThrow('鼠标操作已取消');
  });

  it('hide() still cancels every view', async () => {
    const pointer = new AgentPointer(parentWindow());
    const [a, b] = [view(), view()];
    const onA = heldMove(pointer, a);
    const onB = heldMove(pointer, b);
    await Promise.all([onA.atFirstStep, onB.atFirstStep]);
    pointer.hide();
    onA.release();
    onB.release();
    await expect(onA.done).rejects.toThrow('鼠标操作已取消');
    await expect(onB.done).rejects.toThrow('鼠标操作已取消');
  });

  it("a background tab's move does not hide the pointer of the tab the user watches", async () => {
    const [watched, background] = [view(), view()];
    const pointer = new AgentPointer(parentWindow(), undefined, (target) => target === watched);
    await quickMove(pointer, watched);
    const overlay = overlays.at(-1)!;
    expect(overlay.shown.at(-1)).toBe(true);
    await quickMove(pointer, background);
    expect(overlay.shown.at(-1)).toBe(true);
  });
});
