import { describe, expect, it, vi } from 'vitest';
import { RecordingChannel, type CdpLike, type CdpListener } from '../src/main/browser/index';

function fakeCdp() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const listeners = new Set<CdpListener>();
  const cdp: CdpLike = {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      return {};
    }),
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
  };
  const fire = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener(method, params);
  };
  return { cdp, calls, listeners, fire };
}

const options = {
  script: '(() => {})();',
  bindingName: 'pilion_0123456789abcdef',
  worldName: 'pilion-recorder',
};

describe('RecordingChannel', () => {
  it('start 按固定顺序发命令，并把脚本注入当前文档的隔离世界', async () => {
    const { cdp, calls } = fakeCdp();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage: () => undefined });
    expect(calls.map((call) => call.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.addBinding',
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    expect(calls[2].params).toEqual({
      source: options.script,
      worldName: 'pilion-recorder',
      runImmediately: true,
    });
    expect(calls[3].params).toEqual({
      name: options.bindingName,
      executionContextName: 'pilion-recorder',
    });
    expect(calls[5].params).toEqual({
      frameId: 'frame-main',
      worldName: 'pilion-recorder',
      grantUniveralAccess: false,
    });
    expect(calls[6].params).toEqual({ expression: options.script, contextId: 42 });
    expect(channel.active).toBe(true);
  });

  it('只转发自己 binding 名的 bindingCalled', async () => {
    const { cdp, fire } = fakeCdp();
    const onMessage = vi.fn();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage });
    fire('Runtime.bindingCalled', { name: options.bindingName, payload: '{"kind":"click"}' });
    fire('Runtime.bindingCalled', { name: 'somethingElse', payload: '{"kind":"evil"}' });
    fire('Runtime.consoleAPICalled', { args: [] });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('{"kind":"click"}');
  });

  it('stop 拆掉 binding、脚本与监听，并关掉 Runtime', async () => {
    const { cdp, calls, listeners, fire } = fakeCdp();
    const onMessage = vi.fn();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage });
    calls.length = 0;
    await channel.stop();
    expect(calls.map((call) => call.method)).toEqual([
      'Runtime.removeBinding',
      'Page.removeScriptToEvaluateOnNewDocument',
      'Runtime.disable',
    ]);
    expect(calls[0].params).toEqual({ name: options.bindingName });
    expect(calls[1].params).toEqual({ identifier: 'script-1' });
    expect(listeners.size).toBe(0);
    fire('Runtime.bindingCalled', { name: options.bindingName, payload: '{}' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(channel.active).toBe(false);
  });

  it('重复 start 报错；stop 幂等；拆除时单条命令失败不阻止其余拆除', async () => {
    const { cdp } = fakeCdp();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage: () => undefined });
    await expect(channel.start({ ...options, onMessage: () => undefined })).rejects.toThrow(
      /已在录制/,
    );
    (cdp.sendCommand as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('target closed');
    });
    await expect(channel.stop()).resolves.toBeUndefined();
    await expect(channel.stop()).resolves.toBeUndefined();
    expect(channel.active).toBe(false);
  });

  /** 让某一条命令卡住，直到测试放行：用来把 start 停在半路。 */
  function gatedCdp(gatedMethod: string) {
    const base = fakeCdp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const send = base.cdp.sendCommand;
    base.cdp.sendCommand = async (method, params) => {
      const result = await send(method, params);
      if (method === gatedMethod) {
        reached();
        await gate;
      }
      return result;
    };
    return { ...base, release, atGate };
  }

  it.each([
    'Page.enable',
    'Page.addScriptToEvaluateOnNewDocument',
    'Runtime.addBinding',
    'Page.createIsolatedWorld',
  ])('启动卡在 %s 时被 stop：装到一半的脚本、binding 和监听全部拆掉', async (gated) => {
    const { cdp, calls, listeners, fire, release, atGate } = gatedCdp(gated);
    const onMessage = vi.fn();
    const channel = new RecordingChannel(cdp);
    const starting = channel.start({ ...options, onMessage });
    const failed = starting.then(
      () => 'started',
      (error: Error) => error.message,
    );
    await atGate;
    const stopping = channel.stop();
    // stop 一调用就不算在录了，监听也已经摘掉。
    expect(channel.active).toBe(false);
    expect(listeners.size).toBe(0);
    release();
    await stopping;
    expect(await failed).toBe('录制在启动过程中被停止');
    expect(listeners.size).toBe(0);
    expect(channel.active).toBe(false);
    const methods = calls.map((call) => call.method);
    // 脚本一旦登记过，就一定被按标识移除；最后关掉 Runtime。
    if (methods.includes('Page.addScriptToEvaluateOnNewDocument'))
      expect(calls).toContainEqual({
        method: 'Page.removeScriptToEvaluateOnNewDocument',
        params: { identifier: 'script-1' },
      });
    expect(calls).toContainEqual({
      method: 'Runtime.removeBinding',
      params: { name: options.bindingName },
    });
    expect(methods.at(-1)).toBe('Runtime.disable');
    // 被叫停之后没有再往下装。
    expect(methods).not.toContain('Runtime.evaluate');
    fire('Runtime.bindingCalled', { name: options.bindingName, payload: '{}' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('紧跟着 stop 的下一次 start 等拆除做完：上一次的 Runtime.disable 不会落在新的录制上', async () => {
    const { cdp, calls, listeners } = fakeCdp();
    const channel = new RecordingChannel(cdp);
    await channel.start({ ...options, onMessage: () => undefined });
    calls.length = 0;
    const stopping = channel.stop();
    const restarted = channel.start({
      ...options,
      bindingName: 'pilion_fedcba9876543210',
      onMessage: () => undefined,
    });
    await Promise.all([stopping, restarted]);
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf('Runtime.disable')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('Runtime.disable')).toBeLessThan(methods.indexOf('Page.enable'));
    expect(methods.filter((method) => method === 'Runtime.disable')).toHaveLength(1);
    expect(channel.active).toBe(true);
    expect(listeners.size).toBe(1);
  });

  it('启动途中被 stop 之后还能重新开始录制', async () => {
    const { cdp, listeners, fire, release, atGate } = gatedCdp('Runtime.addBinding');
    const channel = new RecordingChannel(cdp);
    const first = channel.start({ ...options, onMessage: () => undefined }).catch(() => undefined);
    await atGate;
    const stopping = channel.stop();
    const onMessage = vi.fn();
    const second = channel.start({ ...options, bindingName: 'pilion_second', onMessage });
    release();
    await Promise.all([first, stopping, second]);
    expect(channel.active).toBe(true);
    expect(listeners.size).toBe(1);
    fire('Runtime.bindingCalled', { name: 'pilion_second', payload: '{"kind":"click"}' });
    fire('Runtime.bindingCalled', { name: options.bindingName, payload: '{"kind":"old"}' });
    expect(onMessage.mock.calls).toEqual([['{"kind":"click"}']]);
  });
});
