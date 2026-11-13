import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { BROWSERS } from '../src/main/browser/browser-data';
import { chromeSafeStorageSecret } from '../src/main/browser/chrome-cookies';

/** main.ts 的 importChromeCookies 原样在 vm 里跑：execFile 换成记录参数的假实现，不碰真钥匙串。 */
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

async function keychainCall(browser: string) {
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'importChromeCookies',
  )!;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const context: Record<string, unknown> = {
    process: { platform: 'darwin' },
    importBrowserRoot: () => '/browser-root',
    chromeProfiles: async () => [{ id: 'Default', name: 'Default' }],
    chromeSafeStorageSecret,
    BROWSERS,
    execFile: vi.fn(
      (
        command: string,
        args: readonly string[],
        _options: object,
        done: (error: Error | null, stdout: string) => void,
      ) => {
        calls.push({ command, args });
        done(null, 'secret\n');
      },
    ),
    chromeCookieKey: (secret: string) => secret,
    readChromeCookies: async () => ({ cookies: [], unreadable: 0 }),
    join: (...parts: string[]) => parts.join('/'),
    app: { getPath: () => '/user-data' },
    session: { fromPartition: () => ({ cookies: { set: async () => {}, get: async () => [] } }) },
    log() {},
  };
  runInNewContext(
    ts.transpileModule(`${fn.getText(source)}\nglobalThis.run = importChromeCookies;`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  await (context.run as (profile: string, browser: string) => Promise<unknown>)('Default', browser);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

it.each([
  ['chrome', 'Chrome'],
  ['edge', 'Microsoft Edge'],
  ['brave', 'Brave'],
  ['chromium', 'Chromium'],
])('%s reads the Keychain item named after the browser', async (browser, name) => {
  expect(Object.keys(BROWSERS)).toContain(browser);
  const call = await keychainCall(browser);
  expect(call.command).toBe('security');
  expect(call.args).toEqual([
    'find-generic-password',
    '-w',
    '-s',
    `${name} Safe Storage`,
    '-a',
    name,
  ]);
});

it('covers every importable browser', () => {
  expect(Object.keys(BROWSERS).sort()).toEqual(['brave', 'chrome', 'chromium', 'edge']);
});
