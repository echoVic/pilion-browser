import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateController } from '../src/main/updater';

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);

/** 执行主进程自己的函数，只替换 Electron 边界；不启动应用或联网。 */
function mainFunctions(
  names: string[],
  context: Record<string, unknown>,
  optionalNames: string[] = [],
) {
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(names.length);
  const optional = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && optionalNames.includes(node.name.text),
  );
  const code = [...functions, ...optional].map((node) => node.getText(source)).join('\n');
  runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return context;
}

afterEach(() => vi.useRealTimers());

it('broadcasts the configured update state as soon as updates start', async () => {
  vi.useFakeTimers();
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const snapshots: unknown[] = [];
  const context: Record<string, unknown> = {
    app: { isPackaged: true, getVersion: () => '0.1.9' },
    process: { platform: 'linux', env: { APPIMAGE: '/Pilion.AppImage' } },
    require: () => ({ default: { autoUpdater: updater } }),
    UpdateController,
    settings: { data: { autoUpdate: true } },
    updates: undefined,
    shell: { openExternal: vi.fn() },
    emit: () => snapshots.push((context.updates as UpdateController).state),
    broadcast: () => snapshots.push((context.updates as UpdateController).state),
  };
  mainFunctions(['startUpdates'], context);
  await (context.startUpdates as () => Promise<void>)();
  expect(snapshots).toEqual([{ currentVersion: '0.1.9', status: { kind: 'idle' } }]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
});

function runtime() {
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const snapshots: unknown[] = [];
  const preferencesSnapshots: unknown[] = [];
  const save = vi.fn(async () => {});
  const context: Record<string, unknown> = {
    app: { isPackaged: true, getVersion: () => '0.1.9' },
    process: { platform: 'linux', env: { APPIMAGE: '/Pilion.AppImage' } },
    require: () => ({ default: { autoUpdater: updater } }),
    UpdateController,
    settings: { data: { autoUpdate: false } },
    updates: undefined,
    shell: { openExternal: vi.fn() },
    syncAgentShield: vi.fn(),
    state: () => (context.updates as UpdateController).state,
    window: {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, state: unknown) => snapshots.push(state) },
    },
    settingsWindow: {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { send: (_channel: string, state: unknown) => preferencesSnapshots.push(state) },
    },
    refreshMenu: vi.fn(),
    IPC: { state: 'app:state' },
    workspace: { save },
    workspaceTimer: undefined,
    draining: false,
    clearTimeout,
    setTimeout,
  };
  mainFunctions(['startUpdates', 'emit'], context, ['broadcast']);
  return { context, updater, save, snapshots, preferencesSnapshots };
}

it('broadcasts update progress to both windows without scheduling a workspace save', async () => {
  vi.useFakeTimers();
  const { context, updater, save, snapshots, preferencesSnapshots } = runtime();
  await (context.startUpdates as () => Promise<void>)();
  updater.emit('update-available', { version: '0.2.0' });
  for (const percent of [10, 30, 80]) {
    updater.emit('download-progress', { percent });
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(snapshots.at(-1)).toEqual({
    currentVersion: '0.1.9',
    status: { kind: 'downloading', version: '0.2.0', percent: 80 },
  });
  expect(preferencesSnapshots).toEqual(snapshots);
  expect(save).not.toHaveBeenCalled();
});

it('keeps ordinary workspace saves scheduled while update progress arrives', async () => {
  vi.useFakeTimers();
  const { context, updater, save } = runtime();
  await (context.startUpdates as () => Promise<void>)();
  (context.emit as () => void)();
  await vi.advanceTimersByTimeAsync(200);
  updater.emit('update-available', { version: '0.2.0' });
  await vi.advanceTimersByTimeAsync(50);
  expect(save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
  expect(save).toHaveBeenCalledOnce();
});
