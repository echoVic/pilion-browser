import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgv } from '../src/main/external/cli/args.js';
import { runCli, runCommand, type CallTool } from '../src/main/external/cli/commands.js';
import { CliError } from '../src/main/external/cli/output.js';
import { BrowserError } from '../src/main/browser/errors.js';

type Call = { name: string; args: Record<string, unknown> };

function harness(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const call: CallTool = async (request) => {
    calls.push(request);
    if (!(request.name in responses)) throw new Error(`unexpected ${request.name}`);
    return responses[request.name];
  };
  const run = (argv: string[]) => {
    const { command, args } = parseArgv(argv);
    return runCommand(command, {
      args,
      io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
      call: async () => call,
      version: '9.9.9',
    });
  };
  return { calls, out, err, run };
}

const TAB = { id: 't1', title: 'A', url: 'https://a.test/', loading: false };
const REF = {
  id: 'e1',
  tabId: 't1',
  frameId: 'f',
  documentEpoch: 1,
  frameEpoch: 1,
  localFingerprint: 'x',
};

describe('existing commands keep their behaviour', () => {
  it.each([
    ['read', '--tab', ''],
    ['read', '--tab', '   '],
    ['navigate', 'https://example.com/next', '--tab', ''],
    ['navigate', 'https://example.com/next', '--tab', '\t'],
  ])('rejects an explicit empty tab before any browser call: %j', async (...argv) => {
    const h = harness({ 'browser.tabs.list': [TAB] });
    await expect(h.run(argv)).rejects.toThrow(/--tab/);
    expect(h.calls).toEqual([]);
  });

  it('keeps safe browser error fields through the CLI command boundary', async () => {
    const out: string[] = [];
    const { command, args } = parseArgv([
      'click',
      '--tab',
      't1',
      '--ref',
      JSON.stringify(REF),
      '--json',
    ]);
    const code = await runCli(command, {
      args,
      io: { stdout: (line) => out.push(line), stderr: () => {} },
      version: '9.9.9',
      call: async () => async () => {
        throw new BrowserError('STALE_ELEMENT', 'Observe again', true, {
          token: 'must-not-leak',
        });
      },
    });
    expect(code).toBe(1);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { error: 'Observe again', code: 'STALE_ELEMENT', retryable: true },
    ]);
  });

  it('tabs prints one tab per line', async () => {
    const h = harness({ 'browser.tabs.list': [TAB] });
    await h.run(['tabs']);
    expect(h.out).toEqual(['t1\t\tA\thttps://a.test/']);
  });

  it('new prints the tab id', async () => {
    const h = harness({ 'browser.tabs.open': { tabId: 't9' } });
    await h.run(['new', 'https://b.test/']);
    expect(h.calls).toEqual([{ name: 'browser.tabs.open', args: { url: 'https://b.test/' } }]);
    expect(h.out).toEqual(['t9']);
  });

  it('read falls back to the first own tab when --tab is missing', async () => {
    const h = harness({
      'browser.tabs.list': [TAB],
      'browser.snapshot': { url: 'https://a.test/', title: 'A', loading: false, text: 'body' },
    });
    await h.run(['read']);
    expect(h.calls[1]).toEqual({ name: 'browser.snapshot', args: { tabId: 't1' } });
    expect(h.out).toEqual(['A\nhttps://a.test/\n\nbody']);
  });

  it('click requires --ref and parses it as JSON', async () => {
    const h = harness({ 'browser.click': { ok: true } });
    await expect(h.run(['click', '--tab', 't1'])).rejects.toBeInstanceOf(CliError);
    await h.run(['click', '--tab', 't1', '--ref', JSON.stringify(REF)]);
    expect(h.calls.at(-1)).toEqual({
      name: 'browser.click',
      args: { tabId: 't1', elementRef: REF },
    });
  });

  it('a malformed --ref is a CliError, not a JSON stack trace', async () => {
    const h = harness({});
    await expect(h.run(['click', '--tab', 't1', '--ref', '{oops'])).rejects.toThrow(/--ref/);
  });

  it('type passes replace when --replace is given', async () => {
    const h = harness({ 'browser.type': { ok: true } });
    await h.run(['type', '--tab', 't1', '--ref', JSON.stringify(REF), '--text', 'hi', '--replace']);
    expect(h.calls[0]!.args).toEqual({ tabId: 't1', elementRef: REF, text: 'hi', replace: true });
  });

  it('screenshot refuses non-png, existing files and symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-cli-'));
    const h = harness({
      'browser.screenshot': { mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
    });
    await expect(h.run(['screenshot', '--tab', 't1', '-o', join(dir, 'a.jpg')])).rejects.toThrow(
      /\.png/,
    );
    const file = join(dir, 'a.png');
    await h.run(['screenshot', '--tab', 't1', '-o', file]);
    expect(await readFile(file, 'utf8')).toBe('png');
    await expect(h.run(['screenshot', '--tab', 't1', '-o', file])).rejects.toThrow(/--force/);
    await h.run(['screenshot', '--tab', 't1', '-o', file, '--force']);
    const target = join(dir, 'target.png');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'link.png'));
    await expect(
      h.run(['screenshot', '--tab', 't1', '-o', join(dir, 'link.png'), '--force']),
    ).rejects.toThrow(/符号链接/);
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('an unknown command prints usage as a CliError', async () => {
    const h = harness({});
    await expect(h.run(['nope'])).rejects.toThrow(/用法: pilion/);
  });
});

import { GUIDE_SENTINEL } from '../src/main/external/cli/guide.js';

describe('new commands', () => {
  it.each(['activate', 'close'])('%s returns one JSON acknowledgement', async (command) => {
    const h = harness({ [`browser.tabs.${command}`]: { ok: true } });
    await h.run([command, 't1', '--json']);
    expect(h.out).toEqual(['{"ok":true}']);
  });

  it('passes observation offset without altering service-issued refs', async () => {
    const h = harness({
      'browser.observe': { elements: [{ ref: REF, role: 'link', name: 'Next' }] },
    });
    await h.run(['observe', '--tab', 't1', '--offset', '200', '--json']);
    expect(h.calls).toEqual([{ name: 'browser.observe', args: { tabId: 't1', offset: 200 } }]);
    expect(JSON.parse(h.out[0]!)[0].ref).toEqual(REF);
  });

  it('reads an exact ref and multiline text from files before sending an effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pilion-input-'));
    const refFile = join(dir, 'ref.json');
    const textFile = join(dir, 'text.txt');
    await writeFile(refFile, JSON.stringify(REF));
    await writeFile(textFile, "O'Connor\n$(must-not-run) `literal`\n");
    const h = harness({ 'browser.type': { ok: true } });
    await h.run(['type', '--tab', 't1', '--ref-file', refFile, '--text-file', textFile, '--json']);
    expect(h.calls).toEqual([
      {
        name: 'browser.type',
        args: { tabId: 't1', elementRef: REF, text: "O'Connor\n$(must-not-run) `literal`\n" },
      },
    ]);
  });

  it('rejects mixed inline and file inputs before connecting', async () => {
    const h = harness({});
    await expect(
      h.run(['type', '--ref', JSON.stringify(REF), '--ref-file', '/missing', '--text', 'x']),
    ).rejects.toThrow(/--ref.*--ref-file/);
    await expect(
      h.run(['type', '--ref', JSON.stringify(REF), '--text', 'x', '--text-file', '/missing']),
    ).rejects.toThrow(/--text.*--text-file/);
    expect(h.calls).toEqual([]);
  });

  it('rejects unknown, incomplete and command-inapplicable flags without a browser call', async () => {
    const h = harness({});
    await expect(h.run(['read', '--tab', 't1', '--jsno'])).rejects.toThrow(/--jsno/);
    await expect(h.run(['type', '--tab', 't1', '--ref', '--text', 'hi'])).rejects.toThrow(/--ref/);
    await expect(
      h.run(['click', '--tab', 't1', '--ref', JSON.stringify(REF), '--off']),
    ).rejects.toThrow(/--off/);
    await expect(h.run(['read', '--tab', 't1', 'unexpected'])).rejects.toThrow(/unexpected/);
    expect(h.calls).toEqual([]);
  });

  it.each(['-1', '1.5', 'NaN', '100001'])(
    'rejects invalid observation offset %s locally',
    async (offset) => {
      const h = harness({});
      await expect(h.run(['observe', '--tab', 't1', '--offset', offset])).rejects.toThrow(
        /--offset/,
      );
      expect(h.calls).toEqual([]);
    },
  );

  it('skill prints the guide ending with the sentinel and never resolves credentials', async () => {
    const out: string[] = [];
    const { command, args } = parseArgv(['skill']);
    await runCommand(command, {
      args,
      io: { stdout: (l) => out.push(l), stderr: () => undefined },
      call: async () => {
        throw new Error('must not connect');
      },
      version: '9.9.9',
    });
    const text = out.join('\n');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(text.trimEnd().split('\n').at(-1)).toBe(`${GUIDE_SENTINEL} (pilion 9.9.9)`);
    expect(text).toContain('pilion observe');
  });

  it('version prints the CLI version', async () => {
    const h = harness({});
    await h.run(['version']);
    expect(h.out).toEqual(['9.9.9']);
  });

  it('info calls page_info', async () => {
    const h = harness({
      'browser.page_info': { title: 'A', url: 'https://a.test/', loading: false },
    });
    await h.run(['info', '--tab', 't1']);
    expect(h.calls).toEqual([{ name: 'browser.page_info', args: { tabId: 't1' } }]);
    expect(h.out[0]).toContain('https://a.test/');
  });

  it('select sends value', async () => {
    const h = harness({ 'browser.select': { ok: true } });
    await expect(h.run(['select', '--tab', 't1', '--ref', JSON.stringify(REF)])).rejects.toThrow(
      /--value/,
    );
    await h.run(['select', '--tab', 't1', '--ref', JSON.stringify(REF), '--value', 'b']);
    expect(h.calls.at(-1)!.args).toEqual({ tabId: 't1', elementRef: REF, value: 'b' });
  });

  it('check sends checked, --off sends false', async () => {
    const h = harness({ 'browser.check': { ok: true } });
    await h.run(['check', '--tab', 't1', '--ref', JSON.stringify(REF)]);
    await h.run(['check', '--tab', 't1', '--ref', JSON.stringify(REF), '--off']);
    expect(h.calls.map((c) => c.args.checked)).toEqual([true, false]);
  });

  it('press takes the key as a positional and validates it', async () => {
    const h = harness({ 'browser.press': { ok: true } });
    await expect(
      h.run(['press', 'F13', '--tab', 't1', '--ref', JSON.stringify(REF)]),
    ).rejects.toThrow(/Enter/);
    await h.run(['press', 'Enter', '--tab', 't1', '--ref', JSON.stringify(REF)]);
    expect(h.calls.at(-1)!.args).toEqual({ tabId: 't1', elementRef: REF, key: 'Enter' });
  });

  it('status prints one line per check and fails when any check fails', async () => {
    const out: string[] = [];
    const { command, args } = parseArgv(['status']);
    const ctx = {
      args,
      io: { stdout: (l: string) => out.push(l), stderr: () => undefined },
      call: async () => {
        throw new Error('unused');
      },
      version: '9.9.9',
      status: async () => [
        { item: 'socket', ok: true, detail: '/tmp/x.sock' },
        { item: 'credential', ok: false, detail: '没有凭证：在 Pilion 设置里点「安装到 Agent」' },
      ],
    };
    await expect(runCommand(command, ctx)).rejects.toThrow(/credential/);
    expect(out).toEqual([
      'socket\tok\t/tmp/x.sock',
      'credential\tFAIL\t没有凭证：在 Pilion 设置里点「安装到 Agent」',
    ]);
  });

  it('status --json prints exactly one compact JSON document and still fails', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const { command, args } = parseArgv(['status', '--json']);
    const ctx = {
      args,
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
      call: async () => {
        throw new Error('unused');
      },
      version: '9.9.9',
      status: async () => [
        { item: 'socket', ok: true, detail: '/tmp/x.sock' },
        { item: 'credential', ok: false, detail: 'missing' },
      ],
    };
    // 经入口同一条错误出口跑一遍：静默的 CliError 只设退出码，不再追加 {"error"} 文档。
    const code = await runCli(command, ctx);
    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('\n');
    expect(JSON.parse(out[0]!)).toEqual({
      ok: false,
      checks: [
        { item: 'socket', ok: true, detail: '/tmp/x.sock' },
        { item: 'credential', ok: false, detail: 'missing' },
      ],
    });
  });

  it('status --json exits 0 with ok:true when every check passes', async () => {
    const out: string[] = [];
    const { command, args } = parseArgv(['status', '--json']);
    const code = await runCli(command, {
      args,
      io: { stdout: (l: string) => out.push(l), stderr: () => undefined },
      call: async () => {
        throw new Error('unused');
      },
      version: '9.9.9',
      status: async () => [{ item: 'cli', ok: true, detail: 'pilion 9.9.9' }],
    });
    expect(code).toBe(0);
    expect(out).toEqual([
      '{"ok":true,"checks":[{"item":"cli","ok":true,"detail":"pilion 9.9.9"}]}',
    ]);
  });

  it('status in text mode still prints the lines and the error message with exit code 1', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const { command, args } = parseArgv(['status']);
    const code = await runCli(command, {
      args,
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
      call: async () => {
        throw new Error('unused');
      },
      version: '9.9.9',
      status: async () => [{ item: 'credential', ok: false, detail: 'missing' }],
    });
    expect(code).toBe(1);
    expect(out).toEqual(['credential\tFAIL\tmissing']);
    expect(err).toEqual(['检查未通过：credential']);
  });
});
