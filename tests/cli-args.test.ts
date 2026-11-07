import { expect, it } from 'vitest';
import { parseArgv } from '../src/main/external/cli/args.js';

it('takes the first positional as the command and keeps the rest', () => {
  expect(parseArgv(['new', 'https://a.test/'])).toEqual({
    command: 'new',
    args: { json: false, force: false, off: false, replace: false, rest: ['https://a.test/'] },
  });
});

it('reads value flags and booleans anywhere in argv', () => {
  const { command, args } = parseArgv([
    '--json',
    'type',
    '--tab',
    't1',
    '--ref',
    '{"id":"e"}',
    '--text',
    'hi',
    '--replace',
  ]);
  expect(command).toBe('type');
  expect(args).toMatchObject({
    json: true,
    tab: 't1',
    ref: '{"id":"e"}',
    text: 'hi',
    replace: true,
  });
});

it('reads -o / --out, --value, --off, --force', () => {
  expect(parseArgv(['screenshot', '-o', 'a.png', '--force']).args).toMatchObject({
    out: 'a.png',
    force: true,
  });
  expect(parseArgv(['select', '--value', 'x']).args.value).toBe('x');
  expect(parseArgv(['check', '--off']).args.off).toBe(true);
});

it('returns an empty command for no argv', () => {
  expect(parseArgv([]).command).toBe('');
});

it('parses --space flag', () => {
  expect(parseArgv(['new', 'https://a.test/', '--space', 'agent-1'])).toMatchObject({
    command: 'new',
    args: { space: 'agent-1' },
  });
});

it('--space with no value records an error', () => {
  expect(parseArgv(['new', 'https://a.test/', '--space']).args.error).toMatch(/--space/);
});

it('--space does not consume a following flag as its value', () => {
  const { args } = parseArgv(['new', 'https://a.test/', '--space', '--json']);
  expect(args.error).toMatch(/--space/);
  expect(args.json).toBe(true);
  expect(args.space).toBeUndefined();
});

it('accepts repeated --file for upload and parses --amount', () => {
  const { command, args } = parseArgv([
    'upload',
    '--ref',
    '{"id":"e"}',
    '--file',
    '/tmp/a.png',
    '--file',
    '/tmp/b.png',
  ]);
  expect(command).toBe('upload');
  expect(args.files).toEqual(['/tmp/a.png', '/tmp/b.png']);
  expect(args.error).toBeUndefined();

  const scroll = parseArgv(['scroll', 'down', '--amount', '640']);
  expect(scroll.command).toBe('scroll');
  expect(scroll.args.amount).toBe('640');
});

it('still rejects duplicated non-repeatable flags', () => {
  expect(parseArgv(['observe', '--tab', 'a', '--tab', 'b']).args.error).toMatch(/重复选项/);
});
