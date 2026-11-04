/** `pilion` 的参数解析：纯函数，便于单测。值类参数取下一个 argv；布尔开关出现即为 true。 */
export type CliArgs = {
  json: boolean;
  tab?: string;
  space?: string;
  error?: string;
  ref?: string;
  text?: string;
  value?: string;
  out?: string;
  force: boolean;
  off: boolean;
  replace: boolean;
  rest: string[];
};

const VALUE_FLAGS: Record<string, 'tab' | 'space' | 'ref' | 'text' | 'value' | 'out'> = {
  '--tab': 'tab',
  '--space': 'space',
  '--ref': 'ref',
  '--text': 'text',
  '--value': 'value',
  '-o': 'out',
  '--out': 'out',
};
const BOOL_FLAGS: Record<string, 'json' | 'force' | 'off' | 'replace'> = {
  '--json': 'json',
  '--force': 'force',
  '--off': 'off',
  '--replace': 'replace',
};

export function parseArgv(argv: string[]): { command: string; args: CliArgs } {
  const args: CliArgs = { json: false, force: false, off: false, replace: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const valueKey = VALUE_FLAGS[arg];
    const boolKey = BOOL_FLAGS[arg];
    if (valueKey) {
      if (valueKey === 'space' && (!argv[i + 1] || argv[i + 1]!.startsWith('-'))) {
        args.error = '--space 需要一个空间 id';
      } else {
        args[valueKey] = argv[++i];
      }
    } else if (boolKey) args[boolKey] = true;
    else args.rest.push(arg);
  }
  const command = args.rest.shift() ?? '';
  return { command, args };
}
