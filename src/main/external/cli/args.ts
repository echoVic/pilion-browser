/** `pilion` 的参数解析：纯函数，便于单测。值类参数取下一个 argv；布尔开关出现即为 true。 */
export type CliArgs = {
  json: boolean;
  tab?: string;
  space?: string;
  error?: string;
  ref?: string;
  refFile?: string;
  text?: string;
  textFile?: string;
  offset?: string;
  value?: string;
  out?: string;
  force: boolean;
  off: boolean;
  replace: boolean;
  rest: string[];
  /** Validation stays in runCli so even malformed --json calls have one JSON error. */
  flags?: string[];
};

const VALUE_FLAGS: Record<
  string,
  'tab' | 'space' | 'ref' | 'refFile' | 'text' | 'textFile' | 'value' | 'out' | 'offset'
> = {
  '--tab': 'tab',
  '--space': 'space',
  '--ref': 'ref',
  '--ref-file': 'refFile',
  '--text': 'text',
  '--text-file': 'textFile',
  '--offset': 'offset',
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
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const valueKey = VALUE_FLAGS[arg];
    const boolKey = BOOL_FLAGS[arg];
    if (valueKey || boolKey) {
      (args.flags ??= []).push(arg);
      const key = valueKey ?? boolKey;
      if (seen.has(key!)) args.error ??= `重复选项：${arg}`;
      seen.add(key!);
      if (boolKey) args[boolKey] = true;
      else {
        const next = argv[i + 1];
        if (
          next === undefined ||
          Object.hasOwn(VALUE_FLAGS, next) ||
          Object.hasOwn(BOOL_FLAGS, next)
        )
          args.error ??= `${arg} 缺少值`;
        else args[valueKey!] = argv[++i];
      }
    } else if (arg === '--') {
      args.rest.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) args.error ??= `未知选项：${arg}；运行 pilion skill 查看用法`;
    else args.rest.push(arg);
  }
  const command = args.rest.shift() ?? '';
  return { command, args };
}
