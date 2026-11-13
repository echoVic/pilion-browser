import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

/** init() 里紧跟 reconcileExecuting 的那条台账瘦身语句，原样拿出来在 vm 里跑。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function pruneStatement(): ts.Statement {
  const init = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'init',
  )!;
  const statements = init.body!.statements;
  const reconcile = statements.findIndex(
    (node) => node.getText(source) === 'store.reconcileExecuting({});',
  );
  expect(reconcile).toBeGreaterThanOrEqual(0);
  const next = statements[reconcile + 1];
  expect(next?.getText(source)).toContain('store.pruneHistory()');
  return next!;
}

function run(pruneHistory: () => unknown) {
  const error = vi.fn();
  runInNewContext(
    ts.transpileModule(pruneStatement().getText(source), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { store: { pruneHistory: vi.fn(pruneHistory) }, console: { error } },
  );
  return error;
}

it('startup prunes the ledger history right after reconciling executions', () => {
  let pruned = 0;
  const error = run(() => {
    pruned++;
    return { resultPayloadsCleared: 0, outboxDeleted: 0 };
  });
  expect(pruned).toBe(1);
  expect(error).not.toHaveBeenCalled();
});

it('a failed prune only logs, so startup carries on', () => {
  let error: ReturnType<typeof vi.fn> | undefined;
  expect(() => {
    error = run(() => {
      throw new Error('database is locked');
    });
  }).not.toThrow();
  expect(error).toHaveBeenCalledWith('台账瘦身失败', new Error('database is locked'));
});
