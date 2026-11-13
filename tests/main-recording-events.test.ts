import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { MAX_EVENTS, MAX_LOG_BYTES, logCapped } from '../src/main/recording/capture';

/** 过程视图的 IPC 处理函数原样在 vm 里跑：「到了上限」按条数或字节数，先到者为准。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function eventsHandler(events: unknown[]) {
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      !call &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'handle' &&
      node.arguments[0]?.getText(source) === 'IPC.recordingsEvents'
    )
      call = node;
    if (!call) ts.forEachChild(node, visit);
  };
  visit(source);
  expect(call).toBeDefined();
  const context = {
    library: { requireEvents: async () => events },
    renderEvents: () => 'a\nb',
    RENDER_EVENTS_LIMIT: 300,
    logCapped,
    MAX_EVENTS,
  };
  return runInNewContext(
    ts.transpileModule(`(${call!.arguments[2]!.getText(source)})`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as (value: { id: string }) => Promise<{ capped: boolean; clamped: boolean }>;
}

it('a log that stopped at the byte cap, well short of the event count, is reported as capped', async () => {
  const text = 'x'.repeat(1024 * 1024);
  const events = Array.from({ length: Math.ceil(MAX_LOG_BYTES / text.length) + 1 }, (_, i) => ({
    seq: i,
    at: i,
    kind: 'note',
    text,
  }));
  expect(events.length).toBeLessThan(MAX_EVENTS);
  const result = await eventsHandler(events)({ id: 'r1' });
  expect(result.capped).toBe(true);
});

it('a log at the event-count cap is capped, and a short one is not', async () => {
  const small = (length: number) =>
    Array.from({ length }, (_, i) => ({ seq: i, at: i, kind: 'note', text: '' }));
  expect((await eventsHandler(small(MAX_EVENTS))({ id: 'r1' })).capped).toBe(true);
  expect((await eventsHandler(small(3))({ id: 'r1' })).capped).toBe(false);
});
