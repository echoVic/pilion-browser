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
    '--json', 'type', '--tab', 't1', '--ref', '{"id":"e"}', '--text', 'hi', '--replace',
  ]);
  expect(command).toBe('type');
  expect(args).toMatchObject({ json: true, tab: 't1', ref: '{"id":"e"}', text: 'hi', replace: true });
});

it('reads -o / --out, --value, --off, --force', () => {
  expect(parseArgv(['screenshot', '-o', 'a.png', '--force']).args).toMatchObject({ out: 'a.png', force: true });
  expect(parseArgv(['select', '--value', 'x']).args.value).toBe('x');
  expect(parseArgv(['check', '--off']).args.off).toBe(true);
});

it('returns an empty command for no argv', () => {
  expect(parseArgv([]).command).toBe('');
});
