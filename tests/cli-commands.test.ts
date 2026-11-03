import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgv } from '../src/main/external/cli/args.js';
import { runCommand, type CallTool } from '../src/main/external/cli/commands.js';
import { CliError } from '../src/main/external/cli/output.js';

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
const REF = { id: 'e1', tabId: 't1', frameId: 'f', documentEpoch: 1, frameEpoch: 1, localFingerprint: 'x' };

describe('existing commands keep their behaviour', () => {
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
    expect(h.calls.at(-1)).toEqual({ name: 'browser.click', args: { tabId: 't1', elementRef: REF } });
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
    const h = harness({ 'browser.screenshot': { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } });
    await expect(h.run(['screenshot', '--tab', 't1', '-o', join(dir, 'a.jpg')])).rejects.toThrow(/\.png/);
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
