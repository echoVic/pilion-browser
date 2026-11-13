import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

/** main.ts 的 requestAttention / stopFlashFrame 原样在 vm 里跑，窗口换成真的 EventEmitter。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const FUNCTIONS = ['requestAttention', 'stopFlashFrame'];

function load(platform: string) {
  const nodes = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && FUNCTIONS.includes(node.name?.text ?? ''),
  );
  expect(nodes.map((node) => node.name!.text)).toContain('requestAttention');
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => false,
    flashFrame: vi.fn(),
  });
  const bounce = vi.fn();
  const context: Record<string, unknown> = {
    window,
    process: { platform },
    app: { dock: { bounce } },
  };
  runInNewContext(
    ts.transpileModule(
      `${nodes.map((node) => node.getText(source)).join('\n')}
globalThis.requestAttention = requestAttention;`,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  return { requestAttention: context.requestAttention as () => void, window, bounce };
}

it('a run of approvals while the person is away keeps one focus listener, not one per approval', () => {
  const { requestAttention, window } = load('linux');
  for (let i = 0; i < 20; i++) requestAttention();
  expect(window.flashFrame).toHaveBeenCalledTimes(20);
  expect(window.flashFrame).toHaveBeenCalledWith(true);
  expect(window.listenerCount('focus')).toBe(1);
  window.emit('focus');
  expect(window.flashFrame).toHaveBeenLastCalledWith(false);
  expect(window.flashFrame).toHaveBeenCalledTimes(21);
  expect(window.listenerCount('focus')).toBe(0);
  // 回到前台后下一次提醒照样能挂上、照样只挂一个。
  requestAttention();
  requestAttention();
  expect(window.listenerCount('focus')).toBe(1);
});

it('macOS bounces the dock icon and leaves no focus listener behind', () => {
  const { requestAttention, window, bounce } = load('darwin');
  requestAttention();
  requestAttention();
  expect(bounce).toHaveBeenCalledWith('informational');
  expect(window.flashFrame).not.toHaveBeenCalled();
  expect(window.listenerCount('focus')).toBe(0);
});
