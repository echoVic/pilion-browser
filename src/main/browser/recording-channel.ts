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

/** 一次录制在这条通道上装下的东西；拆的时候按它拆。 */
interface ChannelRun {
  readonly options: RecordingChannelOptions;
  readonly listener: CdpListener;
  scriptIdentifier?: string;
  /** 启动途中被 stop()：在途的 start 走到下一步时据此收手、拆掉已装的部分。 */
  cancelled: boolean;
}

/**
 * 录制期间唯一新增的 CDP 面：把一段固定脚本放进隔离世界，并接住它的 binding 回调。
 * 脚本来源只能是 Pilion 自己（Task 4），这里不做任何拼接。
 *
 * 通道的状态机：
 *
 *   idle ──start──▶ starting ──装完──▶ active ──stop──▶ stopping ──拆完──▶ idle
 *                      │
 *                      └──出错，或途中被 stop──▶（拆掉已装的部分）──▶ idle
 *
 * start 和 stop 都要等好几条 CDP 命令。状态只用几个可空字段表示时，启动途中的 stop 会把通道标成
 * 「没在录」，随后 start 接着把脚本、binding 和监听装上去——没有人再去拆，脚本会留在这个标签页
 * 之后打开的每个文档里。所以拆除一律排在装完（或收手）之后，新的 start 也等在途的拆除结束：
 * 拆除的最后一步是关掉 Runtime 域，不能落在下一次录制头上。
 */
export class RecordingChannel {
  #phase: 'idle' | 'starting' | 'active' | 'stopping' = 'idle';
  #run: ChannelRun | undefined;
  /** 在途的 start 或 stop；通道落到 active 或 idle 时结束，从不 reject。 */
  #settling: Promise<void> = Promise.resolve();

  constructor(private readonly cdp: CdpLike) {}

  get active(): boolean {
    return this.#phase === 'active' || (this.#phase === 'starting' && !this.#run?.cancelled);
  }

  async start(options: RecordingChannelOptions): Promise<void> {
    while (this.#tearingDown()) await this.#settling;
    if (this.#phase !== 'idle') throw new Error('该页面已在录制');
    const run: ChannelRun = {
      options,
      cancelled: false,
      listener: (method, params) => {
        if (method !== 'Runtime.bindingCalled') return;
        if (params.name !== options.bindingName || typeof params.payload !== 'string') return;
        options.onMessage(params.payload);
      },
    };
    this.#phase = 'starting';
    this.#run = run;
    const installing = this.#install(run);
    this.#settling = installing.then(
      () => undefined,
      () => undefined,
    );
    return installing;
  }

  /** 每一步都尽力执行；页面已经销毁时命令会失败，但监听与状态仍要清干净。 */
  async stop(): Promise<void> {
    const run = this.#run;
    if (this.#phase === 'idle' || !run) return;
    // 监听同步摘掉：stop() 一返回控制权，就不会再有事件送到 onMessage。
    this.cdp.off(run.listener);
    if (this.#phase === 'starting') run.cancelled = true;
    else if (this.#phase === 'active') {
      this.#phase = 'stopping';
      this.#settling = this.#teardown(run).then(() => this.#idle());
    }
    await this.#settling;
  }

  #tearingDown(): boolean {
    return this.#phase === 'stopping' || (this.#phase === 'starting' && !!this.#run?.cancelled);
  }

  #idle(): void {
    this.#phase = 'idle';
    this.#run = undefined;
  }

  async #install(run: ChannelRun): Promise<void> {
    const { options } = run;
    /** 每条命令回来都看一眼：途中被 stop 了就不再往下装。 */
    const step = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      const result = await this.cdp.sendCommand(method, params);
      if (run.cancelled) throw new Error('录制在启动过程中被停止');
      return result;
    };
    try {
      await step('Page.enable');
      await step('Runtime.enable');
      // 这一条先记下标识再检查：脚本已经登记进页面，被叫停时也要靠标识把它拆掉。
      const added = (await this.cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: options.script,
        worldName: options.worldName,
        runImmediately: true,
      })) as { identifier: string };
      run.scriptIdentifier = added.identifier;
      if (run.cancelled) throw new Error('录制在启动过程中被停止');
      await step('Runtime.addBinding', {
        name: options.bindingName,
        executionContextName: options.worldName,
      });
      this.cdp.on(run.listener);
      const tree = (await step('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      const world = (await step('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: options.worldName,
        grantUniveralAccess: false,
      })) as { executionContextId: number };
      await step('Runtime.evaluate', {
        expression: options.script,
        contextId: world.executionContextId,
      });
      this.#phase = 'active';
    } catch (error) {
      await this.#teardown(run);
      this.#idle();
      throw error;
    }
  }

  async #teardown(run: ChannelRun): Promise<void> {
    this.cdp.off(run.listener);
    const attempt = async (method: string, params?: Record<string, unknown>) => {
      try {
        await this.cdp.sendCommand(method, params);
      } catch {
        /* target may already be gone */
      }
    };
    await attempt('Runtime.removeBinding', { name: run.options.bindingName });
    if (run.scriptIdentifier)
      await attempt('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: run.scriptIdentifier,
      });
    await attempt('Runtime.disable');
  }
}
