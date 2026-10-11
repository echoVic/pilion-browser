import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdateController } from '../src/main/updater';

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);

/** 执行主进程自己的函数，只替换 Electron 边界；不启动应用或联网。 */
function mainFunctions(names: string[], context: Record<string, unknown>) {
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(names.length);
  const code = functions.map((node) => node.getText(source)).join('\n');
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
  };
  mainFunctions(['startUpdates'], context);
  await (context.startUpdates as () => Promise<void>)();
  expect(snapshots).toEqual([{ currentVersion: '0.1.9', status: { kind: 'idle' } }]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
});
