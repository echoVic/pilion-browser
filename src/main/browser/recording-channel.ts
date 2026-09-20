export type CdpListener = (method: string, params: Record<string, unknown>) => void;

/** 适配器把 webContents.debugger 收窄成这个形状，通道本身不认识 Electron。 */
export interface CdpLike {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(listener: CdpListener): void;
  off(listener: CdpListener): void;
}

export interface RecordingChannelOptions {
  script: string;
  bindingName: string;
  worldName: string;
  onMessage(payload: string): void;
}

/**
 * 录制期间唯一新增的 CDP 面：把一段固定脚本放进隔离世界，并接住它的 binding 回调。
 * 脚本来源只能是 Pilion 自己（Task 4），这里不做任何拼接。
 */
export class RecordingChannel {
  #options: RecordingChannelOptions | undefined;
  #scriptIdentifier: string | undefined;
  #listener: CdpListener | undefined;

  constructor(private readonly cdp: CdpLike) {}

  get active(): boolean {
    return this.#options !== undefined;
  }

  async start(options: RecordingChannelOptions): Promise<void> {
    if (this.#options) throw new Error('该页面已在录制');
    this.#options = options;
    const listener: CdpListener = (method, params) => {
      if (method !== 'Runtime.bindingCalled') return;
      if (params.name !== options.bindingName || typeof params.payload !== 'string') return;
      options.onMessage(params.payload);
    };
    this.#listener = listener;
    try {
      await this.cdp.sendCommand('Page.enable');
      await this.cdp.sendCommand('Runtime.enable');
      const added = (await this.cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: options.script,
        worldName: options.worldName,
        runImmediately: true,
      })) as { identifier: string };
      this.#scriptIdentifier = added.identifier;
      await this.cdp.sendCommand('Runtime.addBinding', {
        name: options.bindingName,
        executionContextName: options.worldName,
      });
      this.cdp.on(listener);
      const tree = (await this.cdp.sendCommand('Page.getFrameTree')) as {
        frameTree: { frame: { id: string } };
      };
      const world = (await this.cdp.sendCommand('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: options.worldName,
        grantUniveralAccess: false,
      })) as { executionContextId: number };
      await this.cdp.sendCommand('Runtime.evaluate', {
        expression: options.script,
        contextId: world.executionContextId,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** 每一步都尽力执行；页面已经销毁时命令会失败，但监听与状态仍要清干净。 */
  async stop(): Promise<void> {
    const options = this.#options;
    if (!options) return;
    this.#options = undefined;
    if (this.#listener) this.cdp.off(this.#listener);
    this.#listener = undefined;
    const attempt = async (method: string, params?: Record<string, unknown>) => {
      try {
        await this.cdp.sendCommand(method, params);
      } catch {
        /* target may already be gone */
      }
    };
    await attempt('Runtime.removeBinding', { name: options.bindingName });
    if (this.#scriptIdentifier)
      await attempt('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: this.#scriptIdentifier,
      });
    this.#scriptIdentifier = undefined;
    await attempt('Runtime.disable');
  }
}
