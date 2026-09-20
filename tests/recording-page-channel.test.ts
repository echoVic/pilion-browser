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
});
