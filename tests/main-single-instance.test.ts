import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { claimSingleInstance } from '../src/main/single-instance';

function fakeApp(locked: boolean) {
  const listeners: Array<(event: unknown, argv: string[]) => void> = [];
  return {
    listeners,
    requestSingleInstanceLock: vi.fn(() => locked),
    on: vi.fn((event: 'second-instance', listener: (event: unknown, argv: string[]) => void) => {
      if (event === 'second-instance') listeners.push(listener);
    }),
  };
}

it('a later instance learns it is not primary and registers nothing', () => {
  const app = fakeApp(false);
  const show = vi.fn();
  const openUrl = vi.fn();
  expect(claimSingleInstance(app, { show, openUrl })).toBe(false);
  expect(app.on).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
});

it('the primary shows its window when a second launch brings no link', () => {
  const app = fakeApp(true);
  const show = vi.fn();
  const openUrl = vi.fn();
  expect(claimSingleInstance(app, { show, openUrl })).toBe(true);
  expect(app.listeners).toHaveLength(1);
  app.listeners[0]!({}, ['/Applications/Pilion.app/Contents/MacOS/Pilion', '--allow-file-access']);
  expect(show).toHaveBeenCalledOnce();
  expect(openUrl).not.toHaveBeenCalled();
});

it('the primary queues only the http(s) links a second launch brings', () => {
  const app = fakeApp(true);
  const show = vi.fn();
  const openUrl = vi.fn();
  claimSingleInstance(app, { show, openUrl });
  app.listeners[0]!({}, [
    'C:\\Pilion\\Pilion.exe',
    '--original-process-start-time=1',
    'https://example.com/a',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'HTTP://example.org/b',
    'pilion://open',
  ]);
  expect(openUrl.mock.calls).toEqual([['https://example.com/a'], ['HTTP://example.org/b']]);
  expect(show).not.toHaveBeenCalled();
});

// main.ts 本身起不来（要 Electron）：只核对接线——锁在模块求值时就申请，后来者立即退出、进不了 init。
const main = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

it('main.ts claims the lock at module load and only the primary runs init', () => {
  const statements = main.statements;
  const claim = statements.findIndex(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) =>
          d.name.getText(main) === 'instanceRole' &&
          d.initializer?.getText(main).startsWith('claimSingleInstance(app,'),
      ),
  );
  expect(claim).toBeGreaterThanOrEqual(0);
  const exit = statements.findIndex(
    (node) => node.getText(main) === "if (instanceRole === 'secondary') app.exit(0);",
  );
  expect(exit).toBe(claim + 1);
  // 申请锁之前的顶层语句都只是常量和内存里的表，没有一条会读写 profile。
  for (const node of statements.slice(0, claim)) {
    if (
      ts.isImportDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node)
    )
      continue;
    expect(ts.isVariableStatement(node)).toBe(true);
    expect(node.getText(main)).not.toMatch(/getPath|mkdir|writeFile|readFile|\.load\(\)/);
  }
  const boot = statements.filter((node) => /\.then\(init\)/.test(node.getText(main)));
  expect(boot).toHaveLength(1);
  expect(ts.isIfStatement(boot[0]!)).toBe(true);
  expect((boot[0] as ts.IfStatement).expression.getText(main)).toBe("instanceRole === 'primary'");
});
