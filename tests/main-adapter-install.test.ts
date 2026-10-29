import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdapterInstallState } from '../src/shared/contracts';
import type { LaunchOptions } from '../src/main/agents/local-agents';
import { LOCAL_AGENTS } from '../src/shared/local-agents';

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
afterEach(() => vi.useRealTimers());

/** 和更新测试一样，执行真实主进程函数，只替换 Electron、安装器与 ACP 边界。 */
function runtime(failure?: string) {
  const preset = LOCAL_AGENTS[0];
  const install: AdapterInstallState = {
    presetId: 'claude',
    name: preset.name,
    package: preset.package!,
    startedAt: Date.now(),
  };
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let options: LaunchOptions | undefined;
  const snapshots: { adapterInstall?: AdapterInstallState }[] = [];
  const preferencesSnapshots: { adapterInstall?: AdapterInstallState }[] = [];
  const save = vi.fn(async () => {});
  const events: string[] = [];
  const conversation = { id: 'install-conversation', messages: [] };
  const context: Record<string, unknown> = {
    Date,
    setTimeout,
    clearTimeout,
    disconnectAgent: async () => {},
    agents: [
      {
        id: 'local:claude',
        name: preset.name,
        preset: 'claude',
        enabled: true,
        transport: 'stdio',
      },
    ],
    agentStatus: 'disconnected',
    adapterInstall: undefined,
    lastError: undefined,
    workspace: {
      save,
      current: conversation,
      data: { activeConversationId: conversation.id, conversations: [conversation] },
    },
    workspaceTimer: undefined,
    draining: false,
    broadcastTimer: undefined,
    broadcastPending: false,
    BROADCAST_THROTTLE_MS: 30,
    events,
    BrowserMcpHost: class {
      async start() {}
      async stop() {}
    },
    app: { getPath: () => '/profile' },
    join: (...parts: string[]) => parts.join('/'),
    __dirname: '/main',
    executeTool() {},
    adaptersPath: () => '/profile/adapters',
    resolveLocalLaunch: async (_config: unknown, launchOptions: LaunchOptions) => {
      options = launchOptions;
      options.onInstall?.(preset);
      options.onInstallProgress?.(install);
      await gate;
      options.onInstallProgress?.(undefined);
      if (failure) throw new Error(failure);
      return {};
    },
    processManager: {
      approve: (launch: unknown) => launch,
      connect: async () => {
        throw new Error('stop before transport');
      },
    },
    PROMPT_IDLE_MS: 10_000,
    process: { cwd: () => '/cwd' },
    requestAgentPermission() {},
    syncAgentShield() {},
    state: () => ({ adapterInstall: context.adapterInstall }),
    window: {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, snapshot: { adapterInstall?: AdapterInstallState }) =>
          snapshots.push(snapshot),
      },
    },
    settingsWindow: {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: {
        send: (_channel: string, snapshot: { adapterInstall?: AdapterInstallState }) =>
          preferencesSnapshots.push(snapshot),
      },
    },
    refreshMenu() {},
    IPC: { state: 'app:state' },
  };
  const names = [
    'connectAgent',
    'broadcast',
    'emit',
    'log',
    'readable',
    'throttledBroadcast',
    'flushBroadcast',
  ];
  const code = source.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text))
    .map((node) => node.getText(source))
    .join('\n');
  runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return {
    context,
    install,
    snapshots,
    preferencesSnapshots,
    save,
    events,
    finish,
    progress: (downloadedBytes: number) =>
      options?.onInstallProgress?.({ ...install, downloadedBytes }),
  };
}

it('broadcasts adapter progress to both windows without writing workspace data', async () => {
  vi.useFakeTimers();
  const run = runtime();
  const connecting = (run.context.connectAgent as (id: string) => Promise<void>)(
    'local:claude',
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(300);
  expect(run.snapshots.at(-1)?.adapterInstall).toEqual(run.install);
  expect(run.events.filter((event) => event.includes('首次安装可能需要几分钟'))).toHaveLength(1);
  run.save.mockClear();
  for (const bytes of [1_000_000, 2_000_000, 3_000_000]) {
    run.progress(bytes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.snapshots.at(-1)?.adapterInstall?.downloadedBytes).toBe(bytes);
  }
  expect(run.preferencesSnapshots).toEqual(run.snapshots);
  expect(run.save).not.toHaveBeenCalled();
  run.finish();
  await connecting;
  expect(run.snapshots.at(-1)?.adapterInstall).toBeUndefined();
});

it.each([
  ['success', 161_000, '2 分 41 秒'],
  ['success', 5000, '5 秒'],
  ['npm failure', 5000, undefined],
  ['timeout', 5000, undefined],
  ['abort', 5000, undefined],
] as const)(
  'clears progress after %s and logs elapsed time only for a successful install (%s ms)',
  async (result, duration, elapsed) => {
    vi.useFakeTimers();
    const run = runtime(result === 'success' ? undefined : result);
    const connecting = (run.context.connectAgent as (id: string) => Promise<void>)(
      'local:claude',
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(duration);
    expect(run.snapshots.at(-1)?.adapterInstall).toEqual(run.install);
    run.finish();
    await connecting;
    expect(run.snapshots.at(-1)?.adapterInstall).toBeUndefined();
    expect(run.preferencesSnapshots).toEqual(run.snapshots);
    const installed = run.events.filter((event) => event.includes('ACP 适配器已安装'));
    if (elapsed) {
      expect(installed).toHaveLength(1);
      expect(installed[0]).toContain(`Claude Code 的 ACP 适配器已安装，用时 ${elapsed}`);
    } else expect(installed).toEqual([]);
  },
);
