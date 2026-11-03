# Agent skill + `pilion` CLI — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A terminal agent (Claude Code, Codex, Gemini CLI, Trae) can use Pilion's browser with zero manual setup: the user clicks "安装到 Agent" once, after which a `pilion-browser` skill sits in every agent's skills directory and a `pilion` command sits on PATH with its own credential.

**Architecture:** Three layers. (1) A thin `skills/pilion-browser/SKILL.md` bootstrap, copied from the repo into the app as an extra resource; it tells agents to run `pilion skill`. (2) The existing `src/main/external/pilion-cli.ts`, split into `cli/` modules, gains `skill`, `status`, `version`, `info`, `select`, `check`, `press`; `pilion skill` prints a versioned guide that ends in a sentinel line. (3) A new main-process module `src/main/external/agent-integration.ts` that, on one IPC call, turns on the external channel, issues a dedicated client, writes its token to `<userData>/external/cli.token` (0600), writes a `~/.local/bin/pilion` shell shim, and copies the skill into existing agent skill dirs; it reconciles on every launch and cleans up on remove/revoke.

**Tech Stack:** TypeScript (NodeNext ESM), Electron 43 main process, React renderer, vitest, Playwright Electron E2E, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-03-agent-skill-cli-design.md` (Phase 1 sections only; Phase 2 Agent Spaces is a separate plan).

## Global Constraints

- Work only in worktree `/Users/bytedance/Documents/GitHub/pilion-browser/.worktrees/agent-skill-cli`, branch `feat/agent-skill-cli`. Never touch the main checkout (it holds 21 unrelated uncommitted changes).
- Never use bare `git stash`.
- Windows: external channel stays disabled; all integration UI hidden and `install()` throws `'Windows 暂不支持外部通道'`.
- Files we own carry markers: shim contains the line `# pilion-shim v1`; copied skill dirs contain `.pilion-managed` whose content is the app version. Never overwrite or delete a file/dir without our marker. Refuse symlinks everywhere we write.
- Credential file: `<userData>/external/cli.token`, mode `0600`, created with flag `wx` after unlinking any regular file there; refuse if it is a symlink.
- Integration state file: `<userData>/external/integration.json`, mode `0600`.
- Integration client name: `本机 Agent（CLI）`.
- Shim path: `<home>/.local/bin/pilion`, mode `0755`.
- Skill target parent dirs (only those that already exist): `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.gemini/skills`, `~/.trae/skills`, `~/.cursor/skills`.
- Guide sentinel (last line of `pilion skill`): `[pilion:skill] end of guide`.
- `SKILL.md` `metadata.version` must equal `package.json` `version` (currently `0.2.0`).
- Hello ack changes from `{}` to `{"version":"<app version>"}`; every client and test that waits for the ack must accept both.
- External tool allowlist (`EXTERNAL_TOOLS`) does not change. No in-page JS.
- E2E must never write the real `~/.claude` etc.: main process reads `PILION_INTEGRATION_HOME` (test-only override) before `os.homedir()`, and the E2E sets it to a temp dir.
- User-facing copy is Chinese, matching existing settings copy.
- After each task: `pnpm typecheck && pnpm lint && pnpm vitest run <touched tests>` green before commit. Full `pnpm test` before the final task.

## File Map

| File                                                             | Status            | Responsibility                                                          |
| ---------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `skills/pilion-browser/SKILL.md`                                 | create            | Bootstrap: run `pilion skill`, sentinel rule, when to read install.md   |
| `skills/pilion-browser/references/install.md`                    | create            | Install Pilion, click 安装到 Agent, PATH fix, `pilion status`           |
| `skills/pilion-browser/agents/openai.yaml`                       | create            | Codex display metadata                                                  |
| `.claude/skills/pilion-browser`, `.agents/skills/pilion-browser` | create (symlinks) | `npx skills add echoVic/pilion-browser`                                 |
| `src/main/external/cli/args.ts`                                  | create            | Pure argv parser                                                        |
| `src/main/external/cli/output.ts`                                | create            | `CliIo`, `CliError`, text/json printing                                 |
| `src/main/external/cli/guide.ts`                                 | create            | `GUIDE_SENTINEL`, `renderGuide(version)`                                |
| `src/main/external/cli/commands.ts`                              | create            | One function per command, `runCommand()`                                |
| `src/main/external/cli/version.ts`                               | create            | `cliVersion()` reads package.json next to the app                       |
| `src/main/external/pilion-cli.ts`                                | rewrite (thin)    | parse → runCommand → exit code                                          |
| `src/main/external/client.ts`                                    | modify            | ack carries version; `handshake()` for `status`                         |
| `src/main/external/server.ts`                                    | modify            | `version` option, ack `{"version":…}`, `kind` passthrough on create     |
| `src/main/external/client-registry.ts`                           | modify            | optional `kind: 'agent-integration'` on clients                         |
| `src/main/external/agent-integration.ts`                         | create            | shim/token/skill-copy/state; `install`, `remove`, `reconcile`, `status` |
| `src/shared/contracts.ts`                                        | modify            | `AgentIntegrationView`, IPC names, `ExternalClientView.kind`            |
| `src/preload/index.ts`                                           | modify            | `external.integration.{status,install,remove}`                          |
| `src/main/main.ts`                                               | modify            | wire integration: IPC, startup reconcile, revoke/delete hook            |
| `src/renderer/Preferences.tsx`                                   | modify            | `AgentIntegrationSection` inside 对外控制                               |
| `electron-builder.yml`                                           | modify            | `extraResources` for the skill; fuse comment                            |
| `README.md`, `docs/architecture.md`, `CHANGELOG.md`              | modify            | usage + security trade-off                                              |
| `tests/cli-args.test.ts`                                         | create            | parser                                                                  |
| `tests/cli-commands.test.ts`                                     | create            | commands against a fake `callTool`                                      |
| `tests/skill-package.test.ts`                                    | create            | SKILL.md frontmatter/version, symlinks, sentinel                        |
| `tests/agent-integration.test.ts`                                | create            | shim/token/copy/remove/reconcile on temp dirs                           |
| `tests/external-server.test.ts`                                  | modify            | ack version; `kind`                                                     |
| `tests/preferences-agent-integration.test.ts`                    | create            | section render                                                          |
| `tests/electron.e2e.ts`                                          | modify            | install → real `pilion` subprocess → remove                             |

---

### Task 1: Skill package in the repo

**Files:**

- Create: `skills/pilion-browser/SKILL.md`, `skills/pilion-browser/references/install.md`, `skills/pilion-browser/agents/openai.yaml`
- Create symlinks: `.claude/skills/pilion-browser -> ../../skills/pilion-browser`, `.agents/skills/pilion-browser -> ../../skills/pilion-browser`
- Test: `tests/skill-package.test.ts`

**Interfaces:**

- Produces: directory `skills/pilion-browser/` (consumed by Task 5 as the copy source and Task 8 as `extraResources`).

- [ ] **Step 1: Write the failing test** — `tests/skill-package.test.ts`

```ts
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('missing frontmatter');
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^\s*([a-z_]+):\s*"?(.*?)"?\s*$/.exec(line);
    if (kv && kv[2]) out[kv[1]] = kv[2];
  }
  return out;
}

it('SKILL.md declares the pilion-browser name and the app version', () => {
  const fm = frontmatter(read('skills/pilion-browser/SKILL.md'));
  const pkg = JSON.parse(read('package.json')) as { version: string };
  expect(fm.name).toBe('pilion-browser');
  expect(fm.version).toBe(pkg.version);
  expect(fm.description.length).toBeGreaterThan(80);
});

it('SKILL.md bootstraps through `pilion skill` and names the sentinel', () => {
  const body = read('skills/pilion-browser/SKILL.md');
  expect(body).toContain('pilion skill');
  expect(body).toContain('[pilion:skill] end of guide');
  expect(body).toContain('references/install.md');
});

it('install.md covers the install button, PATH and status', () => {
  const body = read('skills/pilion-browser/references/install.md');
  expect(body).toContain('安装到 Agent');
  expect(body).toContain('$HOME/.local/bin');
  expect(body).toContain('pilion status');
  expect(body).toContain('Windows');
});

it.each(['.claude/skills/pilion-browser', '.agents/skills/pilion-browser'])(
  '%s is a symlink to skills/pilion-browser',
  (link) => {
    expect(lstatSync(new URL(link, root)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(new URL(link, root))).toBe('../../skills/pilion-browser');
  },
);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/skill-package.test.ts`
Expected: FAIL, `ENOENT ... skills/pilion-browser/SKILL.md`.

- [ ] **Step 3: Create `skills/pilion-browser/SKILL.md`**

````markdown
---
name: pilion-browser
description: When you need a browser, read this Skill first. Use it to open and operate websites, read pages, fill forms, click buttons, take screenshots and extract data, and for web app testing, QA and bug investigation. Pilion is the person's own desktop browser with their logged-in sites; every action you take goes through Pilion's approval and audit trail and the person can stop you at any time, so prefer Pilion over built-in browsers or other web tools.
metadata:
  version: '0.2.0'
  date: '2026-11-03'
  bootstrap: true
---

# pilion-browser

Before any browser task, run:

```bash
pilion skill
```

and follow its output. It prints the usage guide that matches the installed
Pilion version. Run it again after Pilion updates, or when any output says to.

The guide ends with a line starting `[pilion:skill] end of guide`. If that
line is missing, the output was truncated: save it to a file and read the
file in parts, for example `pilion skill > "$TMPDIR/pilion-skill.md"`.

## References

- [Install Pilion and connect it to agents](references/install.md) — read when
  `pilion` is not found, when `pilion skill` reports an unknown command, or
  when `pilion status` reports a problem.
````

- [ ] **Step 4: Create `skills/pilion-browser/references/install.md`**

````markdown
# Install Pilion and connect it to agents

Read this file only when `pilion` is not found, when `pilion skill` reports
an unknown command, when `pilion status` reports a problem, or when the user
asks to set Pilion up. For day-to-day browser work, run `pilion skill` and
follow its output.

The `pilion` command is provided by the Pilion desktop app. Pilion runs on
macOS and Linux; its external channel is not available on Windows yet.

## 1. Install the app

Download the latest release from
https://github.com/echoVic/pilion-browser/releases — a `.dmg` on macOS, an
`.AppImage` or `.deb` on Linux — install it and open Pilion.

## 2. Connect Pilion to agents

This step is done by the person in Pilion's window. Ask them to open
**设置 › 通用 › 对外控制** and click **安装到 Agent**, then wait for them to
confirm. That button:

- turns on Pilion's local external channel;
- issues a credential for command-line agents;
- installs the `pilion` command at `~/.local/bin/pilion`;
- copies this skill into the agents' skills directories it finds.

## 3. Check the command

```bash
command -v pilion
```

If it is not found, `~/.local/bin` is not on this shell's PATH. Fix it for
this session and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v pilion
```

Then verify the connection:

```bash
pilion status
```

Every line should end in `ok`. Each line that does not says what to do next
(open Pilion, click 安装到 Agent again, restart Pilion after an update).

## 4. Return to the original task

Run `pilion skill` and follow its output.

## Troubleshooting

- **`pilion status` says Pilion is not running**: ask the person to open Pilion.
- **`credential` is not ok**: the integration was removed or revoked; ask the
  person to click 安装到 Agent again.
- **`version` mismatch**: Pilion was updated while it was running; ask the
  person to restart Pilion.
- **A file already exists at `~/.local/bin/pilion`** that Pilion did not
  create: Pilion will not overwrite it. Ask the person whether to remove it.
- **Windows**: not supported yet.
````

- [ ] **Step 5: Create `skills/pilion-browser/agents/openai.yaml`**

```yaml
interface:
  display_name: 'pilion-browser'
  short_description: "Use the person's own browser, with approvals"
  default_prompt: 'Use $pilion-browser to complete a browser task.'
```

- [ ] **Step 6: Create the symlinks**

```bash
mkdir -p .claude/skills .agents/skills
ln -s ../../skills/pilion-browser .claude/skills/pilion-browser
ln -s ../../skills/pilion-browser .agents/skills/pilion-browser
```

`.claude/` currently holds an untracked `artifacts/` dir only in the main checkout, not in this worktree; add only the symlink.

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run tests/skill-package.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add skills .claude/skills/pilion-browser .agents/skills/pilion-browser tests/skill-package.test.ts
git commit -m "feat(skill): 新增 pilion-browser skill 包（引导式 SKILL.md + 安装说明）"
```

---

### Task 2: Split the CLI into modules, no behaviour change

**Files:**

- Create: `src/main/external/cli/args.ts`, `src/main/external/cli/output.ts`, `src/main/external/cli/commands.ts`
- Rewrite: `src/main/external/pilion-cli.ts`
- Test: `tests/cli-args.test.ts`, `tests/cli-commands.test.ts`

**Interfaces:**

- Produces:
  - `parseArgv(argv: string[]): { command: string; args: CliArgs }` with
    `type CliArgs = { json: boolean; tab?: string; ref?: string; text?: string; value?: string; out?: string; force: boolean; off: boolean; replace: boolean; rest: string[] }`
  - `class CliError extends Error {}` — expected user-facing failures.
  - `interface CliIo { stdout(line: string): void; stderr(line: string): void }`
  - `type CallTool = (request: { name: string; args: Record<string, unknown> }) => Promise<unknown>`
  - `interface CommandContext { args: CliArgs; io: CliIo; call: () => Promise<CallTool>; version: string }`
  - `runCommand(command: string, ctx: CommandContext): Promise<void>` — throws `CliError` or any error; caller prints.
  - `printResult(io: CliIo, json: boolean, value: unknown, text: string): void`
- `call` is lazy so `skill` / `version` never resolve credentials.

- [ ] **Step 1: Write failing parser test** — `tests/cli-args.test.ts`

```ts
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
```

- [ ] **Step 2: Run** `pnpm vitest run tests/cli-args.test.ts` — Expected: FAIL, cannot resolve `cli/args.js`.

- [ ] **Step 3: Implement `src/main/external/cli/args.ts`**

```ts
/** `pilion` 的参数解析：纯函数，便于单测。值类参数取下一个 argv；布尔开关出现即为 true。 */
export type CliArgs = {
  json: boolean;
  tab?: string;
  ref?: string;
  text?: string;
  value?: string;
  out?: string;
  force: boolean;
  off: boolean;
  replace: boolean;
  rest: string[];
};

const VALUE_FLAGS: Record<string, 'tab' | 'ref' | 'text' | 'value' | 'out'> = {
  '--tab': 'tab',
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
    if (valueKey) args[valueKey] = argv[++i];
    else if (boolKey) args[boolKey] = true;
    else args.rest.push(arg);
  }
  const command = args.rest.shift() ?? '';
  return { command, args };
}
```

Note: the test's first case uses `toEqual` with no optional keys present, so never assign `undefined` to optional keys except via a value flag.

- [ ] **Step 4: Implement `src/main/external/cli/output.ts`**

```ts
/** 预期内的用户错误（用法错、文件已存在等）：只打印 message，不打堆栈。 */
export class CliError extends Error {}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** --json 时打印 JSON，否则打印人类可读文本（text 为空串时什么都不打）。 */
export function printResult(io: CliIo, json: boolean, value: unknown, text: string): void {
  if (json) io.stdout(JSON.stringify(value, null, 2));
  else if (text) io.stdout(text);
}

/** 统一错误出口：--json 时 stdout 一行 {error}，否则 stderr。 */
export function printError(io: CliIo, json: boolean, message: string): void {
  if (json) io.stdout(JSON.stringify({ error: message }));
  else io.stderr(message);
}
```

- [ ] **Step 5: Write failing command test** — `tests/cli-commands.test.ts` (existing commands only; Task 3 adds more cases to this file)

```ts
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
const REF = {
  id: 'e1',
  tabId: 't1',
  frameId: 'f',
  documentEpoch: 1,
  frameEpoch: 1,
  localFingerprint: 'x',
};

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
```

Note: the current `--replace` is pushed into `rest` and ignored, so `type` never sent `replace`. Passing `replace: true` is a deliberate small fix; `browser.type` already accepts `replace?: boolean`.

- [ ] **Step 6: Run** `pnpm vitest run tests/cli-commands.test.ts` — Expected: FAIL, cannot resolve `cli/commands.js`.

- [ ] **Step 7: Implement `src/main/external/cli/commands.ts`** (port of today's switch; usage text extended in Task 3)

```ts
import { lstat, mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CliArgs } from './args.js';
import { CliError, printResult, type CliIo } from './output.js';

export type CallTool = (request: {
  name: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

export interface CommandContext {
  args: CliArgs;
  io: CliIo;
  /** 懒取：skill / version / status 不需要（或要自己处理）凭证。 */
  call: () => Promise<CallTool>;
  version: string;
}

type Tab = { id: string; title: string; url: string; loading: boolean };
type Handler = (ctx: CommandContext) => Promise<void>;

export const USAGE = [
  '用法: pilion <命令> [选项]',
  '  tabs                       列出本通道打开的标签',
  '  new <url>                  打开标签',
  '  activate <id>              激活标签',
  '  close <id>                 关闭标签',
  '  navigate <url> [--tab id]  导航',
  '  read [--tab id]            读标签正文',
  '  observe [--tab id]         列出可交互元素（含 elementRef）',
  '  click --ref <json>         点击观察到的元素',
  '  type --ref <json> --text s [--replace]  输入文本',
  '  screenshot -o file.png     截图',
  '全局: --json',
].join('\n');

function need<T>(value: T | undefined, usage: string): T {
  if (value === undefined || value === '') throw new CliError(`用法: ${usage}`);
  return value;
}

function parseRef(raw: string | undefined, usage: string): unknown {
  const text = need(raw, usage);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      '--ref 不是合法 JSON：请从 `pilion observe --json` 的输出里原样复制 elementRef',
    );
  }
}

async function tabId(ctx: CommandContext, call: CallTool): Promise<string> {
  if (ctx.args.tab) return ctx.args.tab;
  const tabs = (await call({ name: 'browser.tabs.list', args: {} })) as Tab[];
  if (!tabs.length) throw new CliError('没有可用标签，先用 `pilion new <url>` 打开一个');
  return tabs[0]!.id;
}

const handlers: Record<string, Handler> = {
  async tabs(ctx) {
    const call = await ctx.call();
    const tabs = (await call({ name: 'browser.tabs.list', args: {} })) as Tab[];
    const text = tabs.length
      ? tabs
          .map((t) => `${t.id}\t${t.loading ? '…' : ''}\t${t.title || '(无标题)'}\t${t.url}`)
          .join('\n')
      : '（没有标签）';
    printResult(ctx.io, ctx.args.json, tabs, text);
  },
  async new(ctx) {
    const url = need(ctx.args.rest[0], 'pilion new <url>');
    const call = await ctx.call();
    const result = (await call({ name: 'browser.tabs.open', args: { url } })) as { tabId: string };
    printResult(ctx.io, ctx.args.json, result, result.tabId);
  },
  async close(ctx) {
    const id = need(ctx.args.rest[0], 'pilion close <tabId>');
    const call = await ctx.call();
    await call({ name: 'browser.tabs.close', args: { tabId: id } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已关闭');
  },
  async activate(ctx) {
    const id = need(ctx.args.rest[0], 'pilion activate <tabId>');
    const call = await ctx.call();
    await call({ name: 'browser.tabs.activate', args: { tabId: id } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已激活');
  },
  async navigate(ctx) {
    const url = need(ctx.args.rest[0], 'pilion navigate <url> [--tab <id>]');
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.navigate',
      args: { tabId: await tabId(ctx, call), url },
    })) as { url: string };
    printResult(ctx.io, ctx.args.json, result, result.url);
  },
  async read(ctx) {
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.snapshot',
      args: { tabId: await tabId(ctx, call) },
    })) as { url: string; title: string; text?: string };
    printResult(
      ctx.io,
      ctx.args.json,
      result,
      `${result.title}\n${result.url}\n\n${result.text ?? ''}`,
    );
  },
  async observe(ctx) {
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.observe',
      args: { tabId: await tabId(ctx, call) },
    })) as { elements: Array<{ ref: unknown; role: string; name: string }> };
    const text = result.elements
      .map((el) => `${el.role}\t${el.name || '(未命名)'}\t${JSON.stringify(el.ref)}`)
      .join('\n');
    printResult(ctx.io, ctx.args.json, result.elements, text);
  },
  async click(ctx) {
    const usage = "pilion click --ref '<elementRef json>' [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    const call = await ctx.call();
    await call({ name: 'browser.click', args: { tabId: await tabId(ctx, call), elementRef } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已点击');
  },
  async type(ctx) {
    const usage = "pilion type --ref '<elementRef json>' --text '...' [--replace] [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    if (ctx.args.text === undefined) throw new CliError(`用法: ${usage}`);
    const call = await ctx.call();
    await call({
      name: 'browser.type',
      args: {
        tabId: await tabId(ctx, call),
        elementRef,
        text: ctx.args.text,
        ...(ctx.args.replace ? { replace: true } : {}),
      },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已输入');
  },
  async screenshot(ctx) {
    const outPath = need(ctx.args.out, 'pilion screenshot -o <file.png> [--force] [--tab <id>]');
    if (!outPath.toLowerCase().endsWith('.png')) throw new CliError('截图输出必须以 .png 结尾');
    // 拒绝 symlink（即便 --force）；默认拒绝已存在的文件，--force 才覆盖。先查再截，避免白截。
    const existing = await lstat(outPath).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new CliError('拒绝写入符号链接路径');
    if (existing && !ctx.args.force) throw new CliError('文件已存在（--force 覆盖）');
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.screenshot',
      args: { tabId: await tabId(ctx, call) },
    })) as { data: string };
    await mkdir(dirname(outPath), { recursive: true });
    await fsWriteFile(outPath, Buffer.from(result.data, 'base64'), {
      flag: existing && ctx.args.force ? 'w' : 'wx',
    });
    printResult(ctx.io, ctx.args.json, { ok: true, file: outPath }, outPath);
  },
};
handlers.snapshot = handlers.read!;

export async function runCommand(command: string, ctx: CommandContext): Promise<void> {
  const handler = handlers[command];
  if (!handler) throw new CliError(USAGE);
  await handler(ctx);
}
```

- [ ] **Step 8: Rewrite `src/main/external/pilion-cli.ts`** as the thin entry

```ts
#!/usr/bin/env node
/**
 * 外部命令行 `pilion`：解析参数 → 交给 cli/commands → 统一错误出口。
 * 输出人类可读文本，加 `--json` 输出机器可读 JSON。与 MCP 入口走同一个认证 socket。
 * 省略 --tab 时默认选「本 principal 自己打开的第一个标签」，绝不碰用户正在看的标签。
 */
import { parseArgv } from './cli/args.js';
import { runCommand, type CallTool } from './cli/commands.js';
import { printError, processIo } from './cli/output.js';
import { callTool, resolveEndpoint } from './client.js';

const { command, args } = parseArgv(process.argv.slice(2));
let tool: CallTool | undefined;
try {
  await runCommand(command, {
    args,
    io: processIo,
    version: '0.0.0',
    call: async () => {
      if (!tool) {
        const endpoint = await resolveEndpoint();
        tool = (request) => callTool(endpoint, request);
      }
      return tool;
    },
  });
} catch (error) {
  printError(processIo, args.json, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
```

(`version: '0.0.0'` is replaced by `cliVersion()` in Task 3.)

- [ ] **Step 9: Run tests and checks**

Run: `pnpm vitest run tests/cli-args.test.ts tests/cli-commands.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/external/cli src/main/external/pilion-cli.ts tests/cli-args.test.ts tests/cli-commands.test.ts
git commit -m "refactor(cli): 把 pilion-cli 拆成 args/output/commands 模块；type 透传 --replace"
```

---

### Task 3: New CLI commands — `skill`, `version`, `status`, `info`, `select`, `check`, `press`; ack carries the version

**Files:**

- Create: `src/main/external/cli/guide.ts`, `src/main/external/cli/version.ts`
- Modify: `src/main/external/cli/commands.ts`, `src/main/external/pilion-cli.ts`, `src/main/external/client.ts`, `src/main/external/server.ts:36-48,503`, `src/main/main.ts:649-655`
- Test: `tests/cli-commands.test.ts` (extend), `tests/external-server.test.ts` (extend)

**Interfaces:**

- Consumes: Task 2's `runCommand`, `CommandContext`, `CliError`.
- Produces:
  - `GUIDE_SENTINEL = '[pilion:skill] end of guide'`; `renderGuide(version: string): string` (ends with `${GUIDE_SENTINEL} (pilion ${version})`).
  - `cliVersion(): string` — reads `version` from the `package.json` two dirs above the compiled `dist/main/main/external/cli/` → i.e. `new URL('../../../../../package.json', import.meta.url)`; returns `'unknown'` on any failure.
  - `CommandContext` gains `status?: () => Promise<StatusReport>` where `type StatusLine = { item: string; ok: boolean; detail: string }` and `type StatusReport = StatusLine[]`.
  - `client.ts`: `handshake(endpoint): Promise<{ version?: string }>` — connect, send hello, resolve with the parsed ack; `callTool` unchanged except it treats any non-error first frame as the ack (it already does).
  - `ExternalServerOptions.version?: string`; ack becomes `` `${JSON.stringify(version ? { version } : {})}\n` ``.

- [ ] **Step 1: Extend the server test with the ack version** — in `tests/external-server.test.ts`:

1. In the `describe('ExternalControlServer (per-client tokens)')` `beforeEach` (line ~108), add `version: '1.2.3',` to the `new ExternalControlServer({ dir, runtime: captured, command: 'pilion-test-node', mcpClientPath: '/tmp/pilion-mcp.js' })` options.
2. Replace every `buf.includes('{}\n')` in the file (lines 43, 180, 205, 263, 285) with `ACK.test(buf)`, and add near the top: `const ACK = /^\{[^\n]*\}\n/m;` — the ack is now `{"version":"1.2.3"}`, and a regex that accepts any single-line object keeps the helpers working for both shapes.
3. Add inside the describe:

```ts
it('acks a successful hello with the app version', async () => {
  const ack = await new Promise<string>((resolve, reject) => {
    const sock = createConnection(server.socketPath);
    let buf = '';
    sock.once('connect', () => sock.write(`${JSON.stringify({ token: clientA.token })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        sock.end();
        resolve(buf.slice(0, nl));
      }
    });
    sock.once('error', reject);
  });
  expect(JSON.parse(ack)).toEqual({ version: '1.2.3' });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/external-server.test.ts -t "app version"` — Expected: FAIL (`{}` ≠ `{version}`).

- [ ] **Step 3: Implement the ack**

In `src/main/external/server.ts` add to `ExternalServerOptions`:

```ts
  /** Pilion 版本：随握手 ack 下发，CLI 的 `status` 用它比对版本。 */
  version?: string;
```

Replace line 503 `socket.write('{}\n');` with:

```ts
socket.write(`${JSON.stringify(this.options.version ? { version: this.options.version } : {})}\n`);
```

In `src/main/main.ts` `startExternalControl()` add `version: app.getVersion(),` to the `new ExternalControlServer({...})` options.

In `tests/electron.e2e.ts` change the three `buf.includes('{}\n')` ack checks (lines ~4711, ~4793, ~4829) to `/^\{[^\n]*\}\n/m.test(buf)`. Careful at ~4711: that helper then waits for `buf.includes('"id"')` — the version ack has no `"id"`, so it is unaffected.

- [ ] **Step 4: Run** `pnpm vitest run tests/external-server.test.ts` — Expected: PASS.

- [ ] **Step 5: Add `handshake` to `src/main/external/client.ts`** (below `callTool`)

```ts
/** 只握手不发请求：`pilion status` 用它检查凭证与服务端版本。 */
export function handshake(endpoint: ExternalEndpoint): Promise<{ version?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, ack?: { version?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(ack ?? {});
    };
    socket.setTimeout(10_000, () => finish(new Error('Pilion 握手超时')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ token: endpoint.token })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buffer.slice(0, nl)) as { error?: string; version?: string };
        if (msg.error) finish(new Error(msg.error));
        else finish(undefined, msg.version ? { version: msg.version } : {});
      } catch {
        finish(new Error('Pilion 返回了无法解析的握手帧'));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => finish(new Error('Pilion 在握手前关闭了连接')));
  });
}
```

- [ ] **Step 6: Create `src/main/external/cli/guide.ts`**

```ts
import { PressKeySchema } from '../../../shared/contracts.js';

/** `pilion skill` 打印的用法指南。随 App 版本发布；SKILL.md 只负责引导 Agent 来读它。 */
export const GUIDE_SENTINEL = '[pilion:skill] end of guide';

export function renderGuide(version: string): string {
  return `# Pilion browser — usage guide (pilion ${version})

Pilion is the person's own desktop browser. You drive it through the \`pilion\`
command. Every command goes through Pilion's trust layer:

- Actions that change a page (navigate, click, type, select, check, press) may
  wait for the person to approve them in Pilion's window. The command blocks
  until they answer, for up to 90 seconds. If it times out, tell the person to
  look at Pilion and approve, then retry once.
- You can only see and touch tabs you opened yourself with \`pilion new\`, plus
  tabs the person explicitly shared. You never see the tab the person is on.
- There is no way to run JavaScript in the page. Do not try to work around it.

## Workflow

1. Open a tab and keep its id:
   \`\`\`bash
   pilion new https://example.com          # prints the tab id, e.g. tab-3
   \`\`\`
2. Read the page:
   \`\`\`bash
   pilion read --tab tab-3                 # title, URL and visible text
   pilion info --tab tab-3                 # title, URL, loading state
   \`\`\`
3. Find something to act on:
   \`\`\`bash
   pilion observe --tab tab-3 --json       # interactive elements with elementRef
   \`\`\`
   Each element has a \`ref\` object. Copy it **exactly** into \`--ref\`. Never
   write or edit a ref by hand. A ref goes stale when the page changes:
   observe again after every navigation or action that changes the page.
4. Act:
   \`\`\`bash
   pilion click  --tab tab-3 --ref '<ref json>'
   pilion type   --tab tab-3 --ref '<ref json>' --text 'hello' [--replace]
   pilion select --tab tab-3 --ref '<ref json>' --value 'option value'
   pilion check  --tab tab-3 --ref '<ref json>' [--off]
   pilion press  Enter --tab tab-3 --ref '<ref json>'
   pilion navigate https://example.com/next --tab tab-3
   \`\`\`
5. Look at it when text is not enough:
   \`\`\`bash
   pilion screenshot --tab tab-3 -o "$TMPDIR/pilion-shot.png"
   \`\`\`
6. When the task is done, close your tabs: \`pilion close tab-3\`.

Always pass \`--tab\`. Without it Pilion picks the first tab you opened, which
is rarely what you mean once you have more than one.

Add \`--json\` to any command for machine-readable output. Errors are printed
as \`{"error": "..."}\` on stdout with \`--json\`, otherwise on stderr, and the
exit code is 1.

## Commands

| Command | Does |
| --- | --- |
| \`pilion tabs\` | List your tabs |
| \`pilion new <url>\` | Open a tab, print its id |
| \`pilion activate <id>\` / \`pilion close <id>\` | Show / close a tab |
| \`pilion navigate <url> --tab <id>\` | Go to a URL |
| \`pilion read --tab <id>\` | Title, URL, visible text |
| \`pilion info --tab <id>\` | Page info |
| \`pilion observe --tab <id>\` | Interactive elements and their refs |
| \`pilion click\` / \`type\` / \`select\` / \`check\` / \`press\` | Act on a ref |
| \`pilion screenshot -o <file.png> --tab <id>\` | PNG screenshot (refuses to overwrite without \`--force\`) |
| \`pilion status\` | Check that Pilion is running and this command is connected |
| \`pilion skill\` | Print this guide |

\`press\` keys: ${PressKeySchema.options.join(', ')}.

## When something fails

- **Denied / 已拒绝**: the person said no. Do not retry the same action; ask
  them what they want instead.
- **Permission denied on a tab**: it is not your tab. Open your own with
  \`pilion new\`.
- **Stale or unknown element**: run \`pilion observe\` again and use a fresh ref.
- **Sign-in, captcha, payment**: stop and ask the person to do that step in
  Pilion, then continue when they say so.
- **Cannot connect / credential errors**: run \`pilion status\` and follow it.

${GUIDE_SENTINEL} (pilion ${version})`;
}
```

The key list comes from `PressKeySchema` (`src/shared/contracts.ts:262-277`) so it never drifts. `browser.page_info` returns `{ ...page.snapshot(), text }` (`main.ts:3226-3232`), i.e. the snapshot fields plus visible text — the `info` handler below prints title/URL/loading only and leaves full text to `read`.

- [ ] **Step 7: Create `src/main/external/cli/version.ts`**

```ts
import { readFileSync } from 'node:fs';

/**
 * CLI 自己的版本：读 App 内的 package.json。编译后本文件在
 * <app>/dist/main/main/external/cli/version.js，package.json 在 <app>/package.json。
 */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
```

- [ ] **Step 8: Write failing tests for the new commands** — append to `tests/cli-commands.test.ts`

```ts
import { GUIDE_SENTINEL } from '../src/main/external/cli/guide.js';

describe('new commands', () => {
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
});
```

- [ ] **Step 9: Run** `pnpm vitest run tests/cli-commands.test.ts` — Expected: FAIL on the new describe block.

- [ ] **Step 10: Implement the new handlers** in `src/main/external/cli/commands.ts`

Add imports and types:

```ts
import { PressKeySchema } from '../../../shared/contracts.js';
import { renderGuide } from './guide.js';

export type StatusLine = { item: string; ok: boolean; detail: string };
export type StatusReport = StatusLine[];
```

Extend `CommandContext` with:

```ts
  /** `pilion status` 的检查项；入口提供真实实现，测试注入假实现。 */
  status?: () => Promise<StatusReport>;
```

Add handlers to the `handlers` object:

```ts
  async skill(ctx) {
    ctx.io.stdout(renderGuide(ctx.version));
  },
  async version(ctx) {
    printResult(ctx.io, ctx.args.json, { version: ctx.version }, ctx.version);
  },
  async status(ctx) {
    if (!ctx.status) throw new CliError('status 不可用');
    const report = await ctx.status();
    if (ctx.args.json) ctx.io.stdout(JSON.stringify(report, null, 2));
    else for (const line of report) ctx.io.stdout(`${line.item}\t${line.ok ? 'ok' : 'FAIL'}\t${line.detail}`);
    const failed = report.filter((line) => !line.ok).map((line) => line.item);
    if (failed.length) throw new CliError(`检查未通过：${failed.join(', ')}`);
  },
  async info(ctx) {
    const call = await ctx.call();
    const result = (await call({
      name: 'browser.page_info',
      args: { tabId: await tabId(ctx, call) },
    })) as { title?: string; url?: string; loading?: boolean };
    printResult(ctx.io, ctx.args.json, result, `${result.title ?? ''}\n${result.url ?? ''}${result.loading ? '\n（加载中）' : ''}`);
  },
  async select(ctx) {
    const usage = "pilion select --ref '<elementRef json>' --value '<option value>' [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    const value = need(ctx.args.value, usage);
    const call = await ctx.call();
    await call({ name: 'browser.select', args: { tabId: await tabId(ctx, call), elementRef, value } });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已选择');
  },
  async check(ctx) {
    const usage = "pilion check --ref '<elementRef json>' [--off] [--tab <id>]";
    const elementRef = parseRef(ctx.args.ref, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.check',
      args: { tabId: await tabId(ctx, call), elementRef, checked: !ctx.args.off },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, ctx.args.off ? '已取消勾选' : '已勾选');
  },
  async press(ctx) {
    const usage = "pilion press <key> --ref '<elementRef json>' [--tab <id>]";
    const key = PressKeySchema.safeParse(need(ctx.args.rest[0], usage));
    if (!key.success) throw new CliError(`不支持的按键；可用：${PressKeySchema.options.join(', ')}`);
    const elementRef = parseRef(ctx.args.ref, usage);
    const call = await ctx.call();
    await call({
      name: 'browser.press',
      args: { tabId: await tabId(ctx, call), elementRef, key: key.data },
    });
    printResult(ctx.io, ctx.args.json, { ok: true }, `已按 ${key.data}`);
  },
```

Extend `USAGE` with these lines before `'全局: --json'`:

```ts
  '  info [--tab id]            页面信息',
  '  select --ref <json> --value v  选择下拉项',
  '  check --ref <json> [--off] 勾选/取消勾选',
  '  press <key> --ref <json>   按键',
  '  status                     检查连接与凭证',
  '  skill                      打印给 Agent 的用法指南',
  '  version                    打印版本',
```

Check the `press` tool's arg schema in `browser-mcp-server.ts:109-113`: it spreads `target` (which includes `elementRef`), so `elementRef` is required. The test above matches that.

- [ ] **Step 11: Wire the real `status` and version into `pilion-cli.ts`**

```ts
#!/usr/bin/env node
/** （保留 Task 2 的文件头注释） */
import { access, constants } from 'node:fs/promises';
import { parseArgv } from './cli/args.js';
import { runCommand, type CallTool, type StatusReport } from './cli/commands.js';
import { printError, processIo } from './cli/output.js';
import { cliVersion } from './cli/version.js';
import { callTool, handshake, resolveEndpoint } from './client.js';

const version = cliVersion();
const { command, args } = parseArgv(process.argv.slice(2));
let tool: CallTool | undefined;

async function status(): Promise<StatusReport> {
  const report: StatusReport = [{ item: 'cli', ok: true, detail: `pilion ${version}` }];
  const socket = process.env.PILION_EXTERNAL_SOCKET;
  const socketOk =
    Boolean(socket) &&
    (await access(socket!, constants.W_OK).then(
      () => true,
      () => false,
    ));
  report.push({
    item: 'socket',
    ok: socketOk,
    detail: socketOk ? socket! : 'Pilion 没有在运行，或「对外控制」已关闭：请打开 Pilion',
  });
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
    report.push({ item: 'credential', ok: true, detail: '已找到' });
  } catch {
    report.push({
      item: 'credential',
      ok: false,
      detail: '没有凭证：在 Pilion「设置 › 对外控制」点「安装到 Agent」',
    });
  }
  if (socketOk && endpoint) {
    try {
      const ack = await handshake(endpoint);
      report.push({ item: 'handshake', ok: true, detail: '已认证' });
      const same = !ack.version || ack.version === version;
      report.push({
        item: 'version',
        ok: same,
        detail: same
          ? `Pilion ${ack.version ?? '(旧版未上报)'}`
          : `Pilion ${ack.version} 与 CLI ${version} 不一致：请重启 Pilion`,
      });
    } catch (error) {
      report.push({
        item: 'handshake',
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)}：凭证可能已被吊销，请重新「安装到 Agent」`,
      });
    }
  }
  return report;
}

try {
  await runCommand(command, {
    args,
    io: processIo,
    version,
    status,
    call: async () => {
      if (!tool) {
        const endpoint = await resolveEndpoint();
        tool = (request) => callTool(endpoint, request);
      }
      return tool;
    },
  });
} catch (error) {
  printError(processIo, args.json, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
```

- [ ] **Step 12: Run tests and checks**

Run: `pnpm vitest run tests/cli-commands.test.ts tests/cli-args.test.ts tests/external-server.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 13: Smoke the built CLI**

```bash
pnpm build >/dev/null && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron dist/main/main/external/pilion-cli.js skill | tail -1
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron dist/main/main/external/pilion-cli.js version
```

Expected: the sentinel line with `(pilion 0.2.0)`, then `0.2.0`. If `version` prints `unknown`, the relative URL in `cliVersion()` is off by one level — fix it against the real `dist/main/main/external/cli/version.js` location.

- [ ] **Step 14: Commit**

```bash
git add src/main/external tests/cli-commands.test.ts tests/external-server.test.ts tests/electron.e2e.ts src/main/main.ts
git commit -m "feat(cli): 新增 pilion skill/status/version/info/select/check/press；握手 ack 带版本"
```

---

### Task 4: Registry `kind` for the integration client

**Files:**

- Modify: `src/main/external/client-registry.ts` (types, `create`, `public`), `src/main/external/server.ts:131-142` (`createClient`), `src/shared/contracts.ts:643-649` (`ExternalClientView`)
- Test: `tests/external-server.test.ts`

**Interfaces:**

- Produces:
  - `type ExternalClientKind = 'agent-integration'`; `ExternalClient.kind?: ExternalClientKind`; `ExternalClientView.kind?: 'agent-integration'`.
  - `ExternalClientRegistry.create(name: string, kind?: ExternalClientKind)`.
  - `ExternalControlServer.createClient(name: string, kind?: ExternalClientKind)` — same return as today.

- [ ] **Step 1: Write the failing test** (inside the per-client describe in `tests/external-server.test.ts`)

```ts
it('records an optional client kind and returns it in listings', async () => {
  const created = await server.createClient('本机 Agent（CLI）', 'agent-integration');
  expect(created.client.kind).toBe('agent-integration');
  const listed = await server.listClients();
  expect(listed.find((c) => c.clientId === created.client.clientId)?.kind).toBe(
    'agent-integration',
  );
  expect(listed.find((c) => c.clientId === clientA.clientId)).not.toHaveProperty('kind');
  const raw = JSON.parse(await readFile(join(dir, 'clients.json'), 'utf8')) as {
    clients: Array<{ clientId: string; kind?: string }>;
  };
  expect(raw.clients.find((c) => c.clientId === created.client.clientId)?.kind).toBe(
    'agent-integration',
  );
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/external-server.test.ts -t "client kind"` — Expected: FAIL (TS error on second argument, or `kind` undefined).

- [ ] **Step 3: Implement**

`client-registry.ts`:

```ts
export type ExternalClientKind = 'agent-integration';

export interface ExternalClient {
  clientId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
  /** 由「安装到 Agent」签发的客户端；UI 显示「集成」徽标，吊销/删除时同时清理本机集成文件。 */
  kind?: ExternalClientKind;
}
```

In `create(name: string, kind?: ExternalClientKind)`, add `...(kind ? { kind } : {}),` to the `entry` literal. In `public(entry)`:

```ts
const { clientId, name, createdAt, lastUsedAt, revokedAt, kind } = entry;
return {
  clientId,
  name,
  createdAt,
  lastUsedAt,
  ...(revokedAt ? { revokedAt } : {}),
  ...(kind ? { kind } : {}),
};
```

`server.ts`: `async createClient(name: string, kind?: ExternalClientKind)` → `this.#registry.create(name, kind)`; import the type. `contracts.ts`: add `kind?: 'agent-integration';` to `ExternalClientView`.

- [ ] **Step 4: Run** `pnpm vitest run tests/external-server.test.ts && pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/external/client-registry.ts src/main/external/server.ts src/shared/contracts.ts tests/external-server.test.ts
git commit -m "feat(external): 客户端注册表支持 kind=agent-integration"
```

---

### Task 5: `agent-integration.ts` — shim, token file, skill copies, state

**Files:**

- Create: `src/main/external/agent-integration.ts`
- Test: `tests/agent-integration.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks at runtime (pure fs module; issuing the client is injected).
- Produces:

```ts
export const SHIM_MARKER = '# pilion-shim v1';
export const MANAGED_FILE = '.pilion-managed';
export const SKILL_NAME = 'pilion-browser';
export const AGENT_SKILL_DIRS: ReadonlyArray<{ agent: string; dir: string }>; // relative to home
export interface IntegrationPaths {
  home: string; // 解析 ~ 的根（E2E 用 PILION_INTEGRATION_HOME 覆盖）
  externalDir: string; // <userData>/external
  socketPath: string; // <externalDir>/external.sock
  executable: string; // shim 里 exec 的可执行文件
  cliScript: string; // <appPath>/dist/main/main/external/pilion-cli.js
  skillSource: string; // 打包后 <resources>/skills/pilion-browser；开发时仓库 skills/pilion-browser
  version: string; // app.getVersion()
}
export interface IntegrationTarget {
  agent: string;
  path: string;
  status: 'installed' | 'skipped-foreign';
}
export interface IntegrationState {
  version: 1;
  clientId: string;
  installedAt: string;
  appVersion: string;
  shimPath: string;
  targets: IntegrationTarget[];
}
export interface IntegrationStatus {
  installed: boolean;
  clientId?: string;
  installedAt?: string;
  shimPath: string;
  shimConflict: boolean; // ~/.local/bin/pilion 存在但不是我们写的
  pathHasShimDir: boolean; // process.env.PATH 是否包含 ~/.local/bin
  targets: IntegrationTarget[]; // 已安装时为 state.targets，否则为将会写入的候选
}
export function renderShim(paths: IntegrationPaths): string;
export function shellQuote(value: string): string;
export class AgentIntegration {
  constructor(paths: IntegrationPaths, env?: { PATH?: string });
  readState(): Promise<IntegrationState | undefined>;
  status(): Promise<IntegrationStatus>;
  /** issue(): 主进程签发集成客户端并返回 {clientId, token}；本方法负责落盘。 */
  install(issue: () => Promise<{ clientId: string; token: string }>): Promise<IntegrationState>;
  /** 启动时调用：已安装才动；重写 shim、刷新落后版本的 skill 拷贝。 */
  reconcile(): Promise<void>;
  /** 删 token、删带标记的 shim、删带标记的 skill 拷贝、删 state。返回被移除的 clientId。 */
  remove(): Promise<string | undefined>;
}
```

- [ ] **Step 1: Write the failing tests** — `tests/agent-integration.test.ts`

```ts
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentIntegration,
  MANAGED_FILE,
  SHIM_MARKER,
  renderShim,
  shellQuote,
  type IntegrationPaths,
} from '../src/main/external/agent-integration.js';

const run = promisify(execFile);

let root: string;
let paths: IntegrationPaths;

async function makeSkillSource(dir: string, version: string) {
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: pilion-browser\nmetadata:\n  version: "${version}"\n---\nbody\n`,
  );
  await writeFile(join(dir, 'references', 'install.md'), 'install');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pilion int'eg "));
  const home = join(root, 'home');
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  await mkdir(join(home, '.codex', 'skills'), { recursive: true });
  const skillSource = join(root, 'app', 'skills', 'pilion-browser');
  await makeSkillSource(skillSource, '1.0.0');
  paths = {
    home,
    externalDir: join(root, 'user data', 'external'),
    socketPath: join(root, 'user data', 'external', 'external.sock'),
    executable: join(root, 'app', 'Pilion'),
    cliScript: join(root, 'app', 'dist', 'main', 'main', 'external', 'pilion-cli.js'),
    skillSource,
    version: '1.0.0',
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const issue =
  (clientId = 'cid1') =>
  async () => ({ clientId, token: `pct_${clientId}_secret` });

describe('shellQuote / renderShim', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote("a b'c")).toBe(`'a b'\\''c'`);
  });

  it('renders a marked POSIX shim that defaults the socket and token file', () => {
    const shim = renderShim(paths);
    expect(shim.startsWith('#!/bin/sh\n')).toBe(true);
    expect(shim).toContain(SHIM_MARKER);
    expect(shim).toContain(`: "\${PILION_EXTERNAL_SOCKET:=`);
    expect(shim).toContain(`: "\${PILION_EXTERNAL_TOKEN_FILE:=`);
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1 exec');
    expect(shim).toContain('"$@"');
  });

  it('the shim runs and forwards env and args (paths with spaces and quotes)', async () => {
    // 用一个假的「可执行文件」打印它收到的环境和参数，验证 shim 的转义和默认值。
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(
      paths.executable,
      '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$PILION_EXTERNAL_SOCKET" "$PILION_EXTERNAL_TOKEN_FILE" "$@"\n',
      { mode: 0o755 },
    );
    const shimFile = join(root, 'shim.sh');
    await writeFile(shimFile, renderShim(paths), { mode: 0o755 });
    const { stdout } = await run(shimFile, ['tabs', '--json'], { env: { PATH: '/usr/bin:/bin' } });
    expect(stdout.split('\n').slice(0, 6)).toEqual([
      '1',
      paths.socketPath,
      join(paths.externalDir, 'cli.token'),
      paths.cliScript,
      'tabs',
      '--json',
    ]);
    const overridden = await run(shimFile, [], {
      env: { PATH: '/usr/bin:/bin', PILION_EXTERNAL_SOCKET: '/x.sock' },
    });
    expect(overridden.stdout.split('\n')[1]).toBe('/x.sock');
  });
});

describe('install', () => {
  it('writes token 0600, shim 0755, copies the skill only into existing agent dirs, and records state', async () => {
    const integration = new AgentIntegration(paths, { PATH: '/usr/bin' });
    const state = await integration.install(issue());
    const token = join(paths.externalDir, 'cli.token');
    expect(await readFile(token, 'utf8')).toBe('pct_cid1_secret\n');
    expect((await stat(token)).mode & 0o777).toBe(0o600);
    const shim = join(paths.home, '.local', 'bin', 'pilion');
    expect((await stat(shim)).mode & 0o777).toBe(0o755);
    expect(await readFile(shim, 'utf8')).toBe(renderShim(paths));
    for (const agent of ['.claude', '.codex']) {
      const target = join(paths.home, agent, 'skills', 'pilion-browser');
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('name: pilion-browser');
      expect(await readFile(join(target, 'references', 'install.md'), 'utf8')).toBe('install');
      expect(await readFile(join(target, MANAGED_FILE), 'utf8')).toBe('1.0.0\n');
    }
    await expect(lstat(join(paths.home, '.gemini'))).rejects.toThrow();
    expect(state.clientId).toBe('cid1');
    expect(state.targets.map((t) => [t.agent, t.status])).toEqual([
      ['Claude Code', 'installed'],
      ['Codex', 'installed'],
    ]);
    const saved = JSON.parse(await readFile(join(paths.externalDir, 'integration.json'), 'utf8'));
    expect(saved).toMatchObject({ version: 1, clientId: 'cid1', appVersion: '1.0.0' });
    expect((await stat(join(paths.externalDir, 'integration.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite a foreign ~/.local/bin/pilion and issues no client', async () => {
    await mkdir(join(paths.home, '.local', 'bin'), { recursive: true });
    await writeFile(join(paths.home, '.local', 'bin', 'pilion'), '#!/bin/sh\necho mine\n');
    let issued = false;
    await expect(
      new AgentIntegration(paths).install(async () => {
        issued = true;
        return { clientId: 'x', token: 't' };
      }),
    ).rejects.toThrow(/已存在.*pilion/);
    expect(issued).toBe(false);
    expect(await readFile(join(paths.home, '.local', 'bin', 'pilion'), 'utf8')).toContain('mine');
  });

  it('refuses a symlinked shim path or token path', async () => {
    await mkdir(join(paths.home, '.local', 'bin'), { recursive: true });
    await writeFile(join(root, 'elsewhere'), 'x');
    await symlink(join(root, 'elsewhere'), join(paths.home, '.local', 'bin', 'pilion'));
    await expect(new AgentIntegration(paths).install(issue())).rejects.toThrow(/符号链接/);

    await rm(join(paths.home, '.local', 'bin', 'pilion'));
    await mkdir(paths.externalDir, { recursive: true });
    await symlink(join(root, 'elsewhere'), join(paths.externalDir, 'cli.token'));
    await expect(new AgentIntegration(paths).install(issue())).rejects.toThrow(/符号链接/);
    expect(await readFile(join(root, 'elsewhere'), 'utf8')).toBe('x');
  });

  it('skips a foreign skill dir with the same name and reports it', async () => {
    const foreign = join(paths.home, '.claude', 'skills', 'pilion-browser');
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'SKILL.md'), 'user-owned');
    const state = await new AgentIntegration(paths).install(issue());
    expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('user-owned');
    expect(state.targets.find((t) => t.agent === 'Claude Code')?.status).toBe('skipped-foreign');
  });

  it('re-install replaces our own token, shim and copies', async () => {
    const integration = new AgentIntegration(paths);
    await integration.install(issue('cid1'));
    await integration.install(issue('cid2'));
    expect(await readFile(join(paths.externalDir, 'cli.token'), 'utf8')).toBe('pct_cid2_secret\n');
    expect((await integration.readState())?.clientId).toBe('cid2');
  });
});

describe('reconcile', () => {
  it('does nothing when not installed', async () => {
    await new AgentIntegration(paths).reconcile();
    await expect(lstat(join(paths.home, '.local', 'bin', 'pilion'))).rejects.toThrow();
  });

  it('rewrites a stale shim and refreshes outdated managed copies only', async () => {
    const first = new AgentIntegration(paths);
    await first.install(issue());
    // App 升级并移动：版本与可执行路径变了。
    await makeSkillSource(paths.skillSource, '2.0.0');
    const moved = { ...paths, executable: join(root, 'moved', 'Pilion'), version: '2.0.0' };
    // 用户自己在 codex 下放了同名 skill（无标记）——不应被动。
    const codex = join(paths.home, '.codex', 'skills', 'pilion-browser');
    await rm(codex, { recursive: true });
    await mkdir(codex);
    await writeFile(join(codex, 'SKILL.md'), 'user-owned');
    await new AgentIntegration(moved).reconcile();
    expect(await readFile(join(paths.home, '.local', 'bin', 'pilion'), 'utf8')).toBe(
      renderShim(moved),
    );
    const claude = join(paths.home, '.claude', 'skills', 'pilion-browser');
    expect(await readFile(join(claude, MANAGED_FILE), 'utf8')).toBe('2.0.0\n');
    expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toContain('2.0.0');
    expect(await readFile(join(codex, 'SKILL.md'), 'utf8')).toBe('user-owned');
  });

  it('leaves a shim that the user replaced alone', async () => {
    const integration = new AgentIntegration(paths);
    await integration.install(issue());
    await writeFile(join(paths.home, '.local', 'bin', 'pilion'), '#!/bin/sh\necho mine\n');
    await integration.reconcile();
    expect(await readFile(join(paths.home, '.local', 'bin', 'pilion'), 'utf8')).toContain('mine');
  });
});

describe('remove', () => {
  it('deletes token, our shim, our copies and state; keeps foreign files', async () => {
    const integration = new AgentIntegration(paths);
    await integration.install(issue());
    const foreignGemini = join(paths.home, '.gemini', 'skills', 'pilion-browser');
    await mkdir(foreignGemini, { recursive: true });
    await writeFile(join(foreignGemini, 'SKILL.md'), 'user-owned');
    expect(await integration.remove()).toBe('cid1');
    await expect(lstat(join(paths.externalDir, 'cli.token'))).rejects.toThrow();
    await expect(lstat(join(paths.home, '.local', 'bin', 'pilion'))).rejects.toThrow();
    await expect(lstat(join(paths.home, '.claude', 'skills', 'pilion-browser'))).rejects.toThrow();
    await expect(lstat(join(paths.externalDir, 'integration.json'))).rejects.toThrow();
    expect(await readFile(join(foreignGemini, 'SKILL.md'), 'utf8')).toBe('user-owned');
    expect(await integration.remove()).toBeUndefined();
  });
});

describe('status', () => {
  it('reports candidates, PATH and conflicts before install', async () => {
    const s = await new AgentIntegration(paths, {
      PATH: `/usr/bin:${join(paths.home, '.local', 'bin')}`,
    }).status();
    expect(s).toMatchObject({ installed: false, shimConflict: false, pathHasShimDir: true });
    expect(s.targets.map((t) => t.agent)).toEqual(['Claude Code', 'Codex']);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/agent-integration.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/main/external/agent-integration.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

/**
 * 「安装到 Agent」：给本机终端 Agent 零配置接上 Pilion。
 * 负责四样本机文件，全部带「是我们写的」标记，绝不覆盖/删除没有标记的同名文件，任何写入点拒绝符号链接：
 *  - <externalDir>/cli.token（0600）：集成客户端的明文 token；
 *  - <home>/.local/bin/pilion（0755）：含 SHIM_MARKER 的 sh 包装脚本；
 *  - <home>/<agent>/skills/pilion-browser/：skill 拷贝，内含 MANAGED_FILE（写版本号）；
 *  - <externalDir>/integration.json（0600）：安装状态。
 * 签发客户端由调用方注入（主进程持有 ExternalControlServer），本模块只做文件系统。
 */

export const SHIM_MARKER = '# pilion-shim v1';
export const MANAGED_FILE = '.pilion-managed';
export const SKILL_NAME = 'pilion-browser';
const TOKEN_FILE = 'cli.token';
const STATE_FILE = 'integration.json';

export const AGENT_SKILL_DIRS: ReadonlyArray<{ agent: string; dir: string }> = [
  { agent: 'Claude Code', dir: '.claude/skills' },
  { agent: 'Codex', dir: '.codex/skills' },
  { agent: 'Agents（通用）', dir: '.agents/skills' },
  { agent: 'Gemini CLI', dir: '.gemini/skills' },
  { agent: 'Trae', dir: '.trae/skills' },
  { agent: 'Cursor', dir: '.cursor/skills' },
];

export interface IntegrationPaths {
  home: string;
  externalDir: string;
  socketPath: string;
  executable: string;
  cliScript: string;
  skillSource: string;
  version: string;
}
export interface IntegrationTarget {
  agent: string;
  path: string;
  status: 'installed' | 'skipped-foreign';
}
export interface IntegrationState {
  version: 1;
  clientId: string;
  installedAt: string;
  appVersion: string;
  shimPath: string;
  targets: IntegrationTarget[];
}
export interface IntegrationStatus {
  installed: boolean;
  clientId?: string;
  installedAt?: string;
  shimPath: string;
  shimConflict: boolean;
  pathHasShimDir: boolean;
  targets: IntegrationTarget[];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderShim(paths: IntegrationPaths): string {
  return [
    '#!/bin/sh',
    `${SHIM_MARKER} — 由 Pilion 生成，每次启动会重写；手动修改会被覆盖`,
    `: "\${PILION_EXTERNAL_SOCKET:=${escapeDq(paths.socketPath)}}"`,
    `: "\${PILION_EXTERNAL_TOKEN_FILE:=${escapeDq(join(paths.externalDir, TOKEN_FILE))}}"`,
    'export PILION_EXTERNAL_SOCKET PILION_EXTERNAL_TOKEN_FILE',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(paths.executable)} ${shellQuote(paths.cliScript)} "$@"`,
    '',
  ].join('\n');
}

/** 默认值出现在双引号参数展开里：转义 " $ ` \ 四个字符即可。 */
function escapeDq(value: string): string {
  return value.replace(/["$`\\]/g, (c) => `\\${c}`);
}

type Entry = 'missing' | 'symlink' | 'file' | 'dir';
async function entry(path: string): Promise<Entry> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 'missing';
  if (info.isSymbolicLink()) return 'symlink';
  return info.isDirectory() ? 'dir' : 'file';
}

async function isOurShim(path: string): Promise<boolean> {
  if ((await entry(path)) !== 'file') return false;
  return (await readFile(path, 'utf8')).split('\n')[1]?.startsWith(SHIM_MARKER) ?? false;
}

async function managedVersion(dir: string): Promise<string | undefined> {
  if ((await entry(dir)) !== 'dir') return undefined;
  const marker = join(dir, MANAGED_FILE);
  if ((await entry(marker)) !== 'file') return undefined;
  return (await readFile(marker, 'utf8')).trim();
}

/** 原子写：同目录临时文件 → chmod → rename。目标若是符号链接，rename 会替换链接本身而不跟随，但我们先行拒绝。 */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode, flag: 'wx' });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export class AgentIntegration {
  constructor(
    private readonly paths: IntegrationPaths,
    private readonly env: { PATH?: string } = process.env,
  ) {}

  private get shimPath(): string {
    return join(this.paths.home, '.local', 'bin', 'pilion');
  }
  private get tokenPath(): string {
    return join(this.paths.externalDir, TOKEN_FILE);
  }
  private get statePath(): string {
    return join(this.paths.externalDir, STATE_FILE);
  }

  async readState(): Promise<IntegrationState | undefined> {
    if ((await entry(this.statePath)) !== 'file') return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as IntegrationState;
      return parsed?.version === 1 && typeof parsed.clientId === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async candidates(): Promise<IntegrationTarget[]> {
    const out: IntegrationTarget[] = [];
    for (const { agent, dir } of AGENT_SKILL_DIRS) {
      const parent = join(this.paths.home, dir);
      if ((await entry(parent)) !== 'dir') continue;
      const path = join(parent, SKILL_NAME);
      const kind = await entry(path);
      const foreign = kind !== 'missing' && (await managedVersion(path)) === undefined;
      out.push({ agent, path, status: foreign ? 'skipped-foreign' : 'installed' });
    }
    return out;
  }

  async status(): Promise<IntegrationStatus> {
    const state = await this.readState();
    const shimKind = await entry(this.shimPath);
    const shimConflict = shimKind !== 'missing' && !(await isOurShim(this.shimPath));
    const shimDir = dirname(this.shimPath);
    const pathHasShimDir = (this.env.PATH ?? '').split(delimiter).includes(shimDir);
    return {
      installed: Boolean(state),
      ...(state ? { clientId: state.clientId, installedAt: state.installedAt } : {}),
      shimPath: this.shimPath,
      shimConflict,
      pathHasShimDir,
      targets: state?.targets ?? (await this.candidates()),
    };
  }

  /** 先做完所有「会拒绝」的检查，再签发客户端，避免拒绝时留下一个没用的 token。 */
  async install(
    issue: () => Promise<{ clientId: string; token: string }>,
  ): Promise<IntegrationState> {
    const shimKind = await entry(this.shimPath);
    if (shimKind === 'symlink') throw new Error(`拒绝写入符号链接：${this.shimPath}`);
    if (shimKind !== 'missing' && !(await isOurShim(this.shimPath)))
      throw new Error(`已存在不是 Pilion 生成的 ${this.shimPath}，请先移走它再安装 pilion 命令`);
    const tokenKind = await entry(this.tokenPath);
    if (tokenKind === 'symlink') throw new Error(`拒绝写入符号链接：${this.tokenPath}`);

    const { clientId, token } = await issue();

    await mkdir(this.paths.externalDir, { recursive: true, mode: 0o700 });
    if (tokenKind === 'file') await unlink(this.tokenPath);
    await writeFile(this.tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(this.tokenPath, 0o600);

    await writeAtomic(this.shimPath, renderShim(this.paths), 0o755);
    const targets = await this.copySkills(true);

    const state: IntegrationState = {
      version: 1,
      clientId,
      installedAt: new Date().toISOString(),
      appVersion: this.paths.version,
      shimPath: this.shimPath,
      targets,
    };
    await writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    return state;
  }

  async reconcile(): Promise<void> {
    const state = await this.readState();
    if (!state) return;
    const expected = renderShim(this.paths);
    const shimKind = await entry(this.shimPath);
    if (
      shimKind === 'missing' ||
      ((await isOurShim(this.shimPath)) && (await readFile(this.shimPath, 'utf8')) !== expected)
    )
      await writeAtomic(this.shimPath, expected, 0o755);
    const targets = await this.copySkills(false);
    if (
      state.appVersion !== this.paths.version ||
      JSON.stringify(targets) !== JSON.stringify(state.targets)
    )
      await writeAtomic(
        this.statePath,
        `${JSON.stringify({ ...state, appVersion: this.paths.version, targets }, null, 2)}\n`,
        0o600,
      );
  }

  async remove(): Promise<string | undefined> {
    const state = await this.readState();
    if ((await entry(this.tokenPath)) === 'file') await unlink(this.tokenPath);
    if (await isOurShim(this.shimPath)) await unlink(this.shimPath);
    for (const { dir } of AGENT_SKILL_DIRS) {
      const path = join(this.paths.home, dir, SKILL_NAME);
      if ((await managedVersion(path)) !== undefined)
        await rm(path, { recursive: true, force: true });
    }
    if ((await entry(this.statePath)) === 'file') await unlink(this.statePath);
    return state?.clientId;
  }

  /** force=true（安装）：重写所有我们管的拷贝；false（启动对账）：只刷新版本落后的。 */
  private async copySkills(force: boolean): Promise<IntegrationTarget[]> {
    const targets = await this.candidates();
    for (const target of targets) {
      if (target.status !== 'installed') continue;
      const current = await managedVersion(target.path);
      if (!force && current === this.paths.version) continue;
      const tmp = `${target.path}.${randomBytes(4).toString('hex')}.tmp`;
      await cp(this.paths.skillSource, tmp, { recursive: true, dereference: true });
      await writeFile(join(tmp, MANAGED_FILE), `${this.paths.version}\n`);
      await rm(target.path, { recursive: true, force: true });
      await rename(tmp, target.path);
    }
    return targets;
  }
}
```

Notes for the implementer:

- `isOurShim` checks line 2 because line 1 is the shebang; `renderShim` must keep the marker on line 2.
- `cp(..., { dereference: true })` matters in dev mode: the repo's `.claude/skills/pilion-browser` is a symlink, but `skillSource` points at the real `skills/pilion-browser`; dereference also protects against symlinks inside the source.
- In `reconcile`, `candidates()` recomputes `skipped-foreign`, so a dir the user replaced after install becomes skipped and is never touched.

- [ ] **Step 4: Run** `pnpm vitest run tests/agent-integration.test.ts` — Expected: PASS. If the "shim runs" test fails on macOS because `/tmp` paths contain no quote, check `root` really contains `'` and a space (`mkdtemp` prefix `"pilion int'eg "`).

- [ ] **Step 5: `pnpm typecheck && pnpm lint`**, then commit

```bash
git add src/main/external/agent-integration.ts tests/agent-integration.test.ts
git commit -m "feat(external): agent-integration 模块（shim / token 文件 / skill 拷贝 / 对账 / 移除）"
```

---

### Task 6: Wire integration into the main process (IPC, startup, revoke/delete)

**Files:**

- Modify: `src/shared/contracts.ts` (IPC names, `AgentIntegrationView`), `src/preload/index.ts:220-233`, `src/main/main.ts` (near `startExternalControl` ~635, the IPC block ~5100-5125, startup ~4384)
- Create: `src/main/external/integration-wiring.ts`
- Test: `tests/integration-wiring.test.ts`, `tests/electron.e2e.ts:1452` (preload key list)

**Interfaces:**

- Consumes: `AgentIntegration`, `IntegrationPaths`, `IntegrationStatus` (Task 5); `ExternalControlServer.createClient(name, kind)`, `.revokeClient(id)` (Task 4).
- Produces:
  - `contracts.ts`:
    ```ts
    export interface AgentIntegrationView {
      supported: boolean;                  // false on win32
      installed: boolean;
      clientId?: string;
      installedAt?: string;
      shimPath: string;
      shimConflict: boolean;
      pathHasShimDir: boolean;
      targets: Array<{ agent: string; path: string; status: 'installed' | 'skipped-foreign' }>;
    }
    // IPC:
    externalIntegrationStatus: 'external:integration-status',
    externalIntegrationInstall: 'external:integration-install',
    externalIntegrationRemove: 'external:integration-remove',
    ```
  - preload: `window.pilion.external.integration = { status(): Promise<AgentIntegrationView>; install(): Promise<AgentIntegrationView>; remove(): Promise<AgentIntegrationView> }`
  - `integration-wiring.ts`:
    ```ts
    export const INTEGRATION_CLIENT_NAME = '本机 Agent（CLI）';
    export interface IntegrationDeps {
      platform: NodeJS.Platform;
      integration: AgentIntegration;
      enableExternal(): Promise<void>; // 存设置 externalControl=true 并等 server 监听
      server(): Pick<ExternalControlServer, 'createClient' | 'revokeClient'> | undefined;
      audit(type: string, payload: Record<string, unknown>): void;
    }
    export function integrationController(deps: IntegrationDeps): {
      status(): Promise<AgentIntegrationView>;
      install(): Promise<AgentIntegrationView>;
      remove(): Promise<AgentIntegrationView>;
      /** server.revokeClient/deleteClient 之后调用：若是集成客户端就清本机文件。 */
      onClientGone(clientId: string): Promise<void>;
      reconcile(): Promise<void>;
    };
    ```

- [ ] **Step 1: Write the failing test** — `tests/integration-wiring.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AgentIntegration } from '../src/main/external/agent-integration.js';
import {
  INTEGRATION_CLIENT_NAME,
  integrationController,
} from '../src/main/external/integration-wiring.js';

function fakeIntegration(state: { clientId?: string }) {
  return {
    status: vi.fn(async () => ({
      installed: Boolean(state.clientId),
      ...(state.clientId ? { clientId: state.clientId } : {}),
      shimPath: '/h/.local/bin/pilion',
      shimConflict: false,
      pathHasShimDir: true,
      targets: [],
    })),
    readState: vi.fn(async () => (state.clientId ? { clientId: state.clientId } : undefined)),
    install: vi.fn(async (issue: () => Promise<{ clientId: string; token: string }>) => {
      const issued = await issue();
      state.clientId = issued.clientId;
      return { clientId: issued.clientId };
    }),
    remove: vi.fn(async () => {
      const id = state.clientId;
      state.clientId = undefined;
      return id;
    }),
    reconcile: vi.fn(async () => undefined),
  } as unknown as AgentIntegration & Record<string, ReturnType<typeof vi.fn>>;
}

function deps(state: { clientId?: string }, platform: NodeJS.Platform = 'darwin') {
  const integration = fakeIntegration(state);
  const server = {
    createClient: vi.fn(async (_name: string, _kind?: string) => ({
      client: { clientId: 'new1' },
      token: 'pct_new1_s',
      config: {},
    })),
    revokeClient: vi.fn(async () => undefined),
  };
  const audit = vi.fn();
  const enableExternal = vi.fn(async () => undefined);
  const controller = integrationController({
    platform,
    integration,
    enableExternal,
    server: () => server as never,
    audit,
  });
  return { controller, integration, server, audit, enableExternal };
}

describe('integrationController', () => {
  it('install enables the channel, issues a kind=agent-integration client and audits', async () => {
    const d = deps({});
    const view = await d.controller.install();
    expect(d.enableExternal).toHaveBeenCalledOnce();
    expect(d.server.createClient).toHaveBeenCalledWith(
      INTEGRATION_CLIENT_NAME,
      'agent-integration',
    );
    expect(view).toMatchObject({ supported: true, installed: true, clientId: 'new1' });
    expect(d.audit).toHaveBeenCalledWith(
      'external.integration.installed',
      expect.objectContaining({ clientId: 'new1' }),
    );
  });

  it('re-install revokes the previous integration client first', async () => {
    const d = deps({ clientId: 'old1' });
    await d.controller.install();
    expect(d.server.revokeClient).toHaveBeenCalledWith('old1');
  });

  it('remove revokes the client and removes local files', async () => {
    const d = deps({ clientId: 'old1' });
    const view = await d.controller.remove();
    expect(d.integration.remove).toHaveBeenCalledOnce();
    expect(d.server.revokeClient).toHaveBeenCalledWith('old1');
    expect(view.installed).toBe(false);
    expect(d.audit).toHaveBeenCalledWith('external.integration.removed', {
      clientId: 'old1',
      reason: 'user',
    });
  });

  it('onClientGone cleans up only for the integration client', async () => {
    const d = deps({ clientId: 'int1' });
    await d.controller.onClientGone('someone-else');
    expect(d.integration.remove).not.toHaveBeenCalled();
    await d.controller.onClientGone('int1');
    expect(d.integration.remove).toHaveBeenCalledOnce();
    expect(d.server.revokeClient).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith('external.integration.removed', {
      clientId: 'int1',
      reason: 'client-revoked',
    });
  });

  it('is unsupported on win32: status says so and install throws', async () => {
    const d = deps({}, 'win32');
    expect((await d.controller.status()).supported).toBe(false);
    await expect(d.controller.install()).rejects.toThrow('Windows 暂不支持外部通道');
    await d.controller.reconcile();
    expect(d.integration.reconcile).not.toHaveBeenCalled();
  });

  it('install fails clearly when the server did not start', async () => {
    const d = deps({});
    const controller = integrationController({
      platform: 'darwin',
      integration: d.integration,
      enableExternal: async () => undefined,
      server: () => undefined,
      audit: () => undefined,
    });
    await expect(controller.install()).rejects.toThrow(/外部控制通道未启动/);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/integration-wiring.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/main/external/integration-wiring.ts`**

```ts
import type { AgentIntegrationView } from '../../shared/contracts.js';
import type { AgentIntegration } from './agent-integration.js';
import type { ExternalControlServer } from './server.js';

export const INTEGRATION_CLIENT_NAME = '本机 Agent（CLI）';

export interface IntegrationDeps {
  platform: NodeJS.Platform;
  integration: AgentIntegration;
  enableExternal(): Promise<void>;
  server(): Pick<ExternalControlServer, 'createClient' | 'revokeClient'> | undefined;
  audit(type: string, payload: Record<string, unknown>): void;
}

/** 「安装到 Agent」的主进程编排：签发/吊销客户端在 server，本机文件在 AgentIntegration。 */
export function integrationController(deps: IntegrationDeps) {
  const supported = deps.platform !== 'win32';

  async function status(): Promise<AgentIntegrationView> {
    const s = await deps.integration.status();
    return { supported, ...s };
  }

  async function install(): Promise<AgentIntegrationView> {
    if (!supported) throw new Error('Windows 暂不支持外部通道');
    await deps.enableExternal();
    const server = deps.server();
    if (!server) throw new Error('外部控制通道未启动，无法签发凭证');
    const previous = (await deps.integration.readState())?.clientId;
    const state = await deps.integration.install(async () => {
      if (previous) await server.revokeClient(previous);
      const created = await server.createClient(INTEGRATION_CLIENT_NAME, 'agent-integration');
      return { clientId: created.client.clientId, token: created.token };
    });
    deps.audit('external.integration.installed', {
      clientId: state.clientId,
      ...(previous ? { replaced: previous } : {}),
      targets: (state.targets ?? []).map((t) => `${t.agent}:${t.status}`),
    });
    return status();
  }

  async function remove(): Promise<AgentIntegrationView> {
    const clientId = await deps.integration.remove();
    if (clientId) {
      await deps.server()?.revokeClient(clientId);
      deps.audit('external.integration.removed', { clientId, reason: 'user' });
    }
    return status();
  }

  async function onClientGone(clientId: string): Promise<void> {
    const state = await deps.integration.readState();
    if (state?.clientId !== clientId) return;
    await deps.integration.remove();
    deps.audit('external.integration.removed', { clientId, reason: 'client-revoked' });
  }

  async function reconcile(): Promise<void> {
    if (!supported) return;
    await deps.integration.reconcile();
  }

  return { status, install, remove, onClientGone, reconcile };
}
```

Add `AgentIntegrationView` and the three IPC names to `src/shared/contracts.ts` exactly as in the Interfaces block (IPC names go in the `IPC` object next to `externalClientDelete`).

Note: `remove()` calls `integration.remove()` before `revokeClient`, and the `revokeClient` IPC handler (Step 5) calls `onClientGone` after revoking. Since `integration.remove()` already deleted the state, the nested `onClientGone` finds no state and does nothing — no double cleanup and no recursion. The direct `server.revokeClient` call in `remove()` does not go through the IPC handler at all.

- [ ] **Step 4: Run** `pnpm vitest run tests/integration-wiring.test.ts` — Expected: PASS.

- [ ] **Step 5: Wire into `main.ts`**

Imports:

```ts
import { AgentIntegration, type IntegrationPaths } from './external/agent-integration.js';
import { integrationController } from './external/integration-wiring.js';
import { homedir } from 'node:os';
```

(Check `homedir` / `join` / `dirname` imports already exist before adding.)

Below `stopExternalControl()` add:

```ts
/** 「安装到 Agent」用到的本机路径。PILION_INTEGRATION_HOME 只给 E2E 用，防止测试写进真实 ~/.claude。 */
function integrationPaths(): IntegrationPaths {
  const externalDir = join(app.getPath('userData'), 'external');
  const executable =
    process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
  return {
    home: process.env.PILION_INTEGRATION_HOME || homedir(),
    externalDir,
    socketPath: join(externalDir, 'external.sock'),
    executable,
    cliScript: join(__dirname, 'external/pilion-cli.js'),
    skillSource: app.isPackaged
      ? join(process.resourcesPath, 'skills/pilion-browser')
      : join(app.getAppPath(), 'skills/pilion-browser'),
    version: app.getVersion(),
  };
}

const agentIntegration = integrationController({
  platform: process.platform,
  integration: new AgentIntegration(integrationPaths()),
  async enableExternal() {
    if (!settings.data.externalControl) await settings.update({ externalControl: true });
    startExternalControl();
    await externalServerReady();
    emit();
  },
  server: () => (externalServer?.isListening ? externalServer : undefined),
  audit: (type, payload) => store.recordEvent('external', type, type, payload),
});
```

`integrationPaths()` calls `app.getPath`, so `agentIntegration` must be created after `app` is ready. If module-level construction runs too early, change it to a lazily initialised `let agentIntegration: ReturnType<typeof integrationController> | undefined` built at the top of the startup function (before line ~4384), and have the IPC handlers call a `requireIntegration()` helper. Check where `settings` and `store` are first assigned and follow the same pattern.

`externalServerReady()`: `startExternalControl()` today fires `start()` and forgets the promise. Change it to store the promise:

```ts
let externalStarting: Promise<void> | undefined;
// inside startExternalControl, replace `externalServer.start().then(...).catch(...)` with:
externalStarting = externalServer
  .start()
  .then(() => emit())
  .catch((error) => {
    lastError = `外部控制通道启动失败：${readable(error)}`;
    emit();
  });
// and add:
async function externalServerReady(): Promise<void> {
  await externalStarting;
}
```

Startup (next to line 4384 `if (settings.data.externalControl) startExternalControl();`):

```ts
void agentIntegration.reconcile().catch((error) => log(`Agent 集成对账失败：${readable(error)}`));
```

IPC (in the `preferences` block next to the other external handlers):

```ts
handle(IPC.externalIntegrationStatus, undefined, () => agentIntegration.status(), preferences);
handle(
  IPC.externalIntegrationInstall,
  undefined,
  async () => {
    const view = await agentIntegration.install();
    emit();
    return view;
  },
  preferences,
);
handle(
  IPC.externalIntegrationRemove,
  undefined,
  async () => {
    const view = await agentIntegration.remove();
    emit();
    return view;
  },
  preferences,
);
```

Change the existing revoke/delete handlers to clean up after themselves:

```ts
handle(
  IPC.externalClientRevoke,
  IdInputSchema,
  async (value) => {
    const result = await externalServer?.revokeClient(value.id);
    await agentIntegration.onClientGone(value.id);
    return result;
  },
  preferences,
);
handle(
  IPC.externalClientDelete,
  IdInputSchema,
  async (value) => {
    const result = await externalServer?.deleteClient(value.id);
    await agentIntegration.onClientGone(value.id);
    return result;
  },
  preferences,
);
```

- [ ] **Step 6: Preload** — in `src/preload/index.ts`, inside `external: Object.freeze({...})` add:

```ts
    /** 「安装到 Agent」：状态 / 安装 / 移除（只在设置窗口可用）。 */
    integration: Object.freeze({
      status: (): Promise<AgentIntegrationView> => ipcRenderer.invoke(IPC.externalIntegrationStatus),
      install: (): Promise<AgentIntegrationView> => ipcRenderer.invoke(IPC.externalIntegrationInstall),
      remove: (): Promise<AgentIntegrationView> => ipcRenderer.invoke(IPC.externalIntegrationRemove),
    }),
```

Import `AgentIntegrationView`. Update `tests/electron.e2e.ts:1452` to
`external: ['clients', 'createClient', 'deleteClient', 'disconnect', 'integration', 'revokeClient'],`.
Also grep `tests/preload-session-identity.test.ts` and any other test that snapshots preload keys (`grep -rn "revokeClient" tests`) and update the same way.

- [ ] **Step 7: Run** `pnpm typecheck && pnpm lint && pnpm vitest run tests/integration-wiring.test.ts tests/external-server.test.ts tests/preload-session-identity.test.ts` — Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/contracts.ts src/preload/index.ts src/main/main.ts src/main/external/integration-wiring.ts tests/integration-wiring.test.ts tests/electron.e2e.ts tests/preload-session-identity.test.ts
git commit -m "feat(external): 接入「安装到 Agent」IPC、启动对账、吊销/删除集成客户端时清理本机文件"
```

---

### Task 7: Settings UI — `AgentIntegrationSection`

**Files:**

- Modify: `src/renderer/Preferences.tsx` (new function component + render it inside `ExternalControlSection`; show 「集成」 badge in the client list), `src/renderer/style.css` or the CSS file that holds `.external-conn-row` (`grep -rn "external-conn-row" src/renderer/*.css`)
- Test: `tests/preferences-agent-integration.test.ts`

**Interfaces:**

- Consumes: `AgentIntegrationView` (Task 6), `window.pilion.external.integration` (Task 6).
- Produces: `function AgentIntegrationSection({ view, busy, onInstall, onRemove }: { view: AgentIntegrationView | undefined; busy: boolean; onInstall(): void; onRemove(): void })` — pure presentational, so it can be rendered in a vm like `UpdateSection` is in `tests/preferences-updates.test.ts`.

- [ ] **Step 1: Write the failing test** — `tests/preferences-agent-integration.test.ts`, copying the vm-extraction pattern from `tests/preferences-updates.test.ts:1-45` but extracting `AgentIntegrationSection`:

```ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { expect, it } from 'vitest';
import type { AgentIntegrationView } from '../src/shared/contracts';

const text = readFileSync(new URL('../src/renderer/Preferences.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const section = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'AgentIntegrationSection',
)!;
const context: Record<string, unknown> = { exports: {}, require: createRequire(import.meta.url) };
runInNewContext(
  ts.transpileModule(section.getText(source), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  context,
);
const Section = context.AgentIntegrationSection as ComponentType<{
  view: AgentIntegrationView | undefined;
  busy: boolean;
  onInstall(): void;
  onRemove(): void;
}>;

const base: AgentIntegrationView = {
  supported: true,
  installed: false,
  shimPath: '/Users/u/.local/bin/pilion',
  shimConflict: false,
  pathHasShimDir: true,
  targets: [
    { agent: 'Claude Code', path: '/Users/u/.claude/skills/pilion-browser', status: 'installed' },
    { agent: 'Codex', path: '/Users/u/.codex/skills/pilion-browser', status: 'skipped-foreign' },
  ],
};
const render = (view: AgentIntegrationView | undefined, busy = false) =>
  renderToStaticMarkup(createElement(Section, { view, busy, onInstall() {}, onRemove() {} }));

it('offers install with the targets it will write and the credential warning', () => {
  const html = render(base);
  expect(html).toContain('安装到 Agent');
  expect(html).toContain('Claude Code');
  expect(html).toContain('已有同名 skill，跳过');
  expect(html).toContain('cli.token');
  expect(html).not.toMatch(/<button[^>]*>移除<\/button>/);
});

it('shows installed state with remove and the PATH hint when needed', () => {
  const html = render({ ...base, installed: true, clientId: 'c1', pathHasShimDir: false });
  expect(html).toContain('重新安装');
  expect(html).toContain('移除');
  expect(html).toContain('export PATH=&quot;$HOME/.local/bin:$PATH&quot;');
});

it('blocks install on a foreign shim', () => {
  const html = render({ ...base, shimConflict: true });
  expect(html).toContain('不是 Pilion 生成的');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>安装到 Agent/);
});

it('renders nothing when unsupported and a placeholder while loading', () => {
  expect(render({ ...base, supported: false })).toBe('');
  expect(render(undefined)).toContain('正在读取');
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/preferences-agent-integration.test.ts` — Expected: FAIL (`section` undefined).

- [ ] **Step 3: Implement** in `src/renderer/Preferences.tsx` (top-level function, below `ExternalControlSection`; import `AgentIntegrationView` in the existing `import type {...} from '../shared/contracts'`):

```tsx
function AgentIntegrationSection({
  view,
  busy,
  onInstall,
  onRemove,
}: {
  view: AgentIntegrationView | undefined;
  busy: boolean;
  onInstall(): void;
  onRemove(): void;
}) {
  if (view && !view.supported) return null;
  if (!view) return <small className="external-hint">正在读取 Agent 集成状态…</small>;
  return (
    <div className="external-integration">
      <span className="prefs-label">Agent 集成</span>
      <small className="external-hint">
        让 Claude Code、Codex 等终端 Agent 直接用 Pilion：安装 <code>pilion</code> 命令到{' '}
        <code>{view.shimPath}</code>，并把 pilion-browser skill 放进下列 Agent 的 skills 目录。
        凭证保存在用户数据目录的 <code>external/cli.token</code>
        （仅本用户可读）；本机任何以你身份运行的进程都能读到它，
        它和其他外部客户端一样只能操作自己开的标签，改动页面的操作都要你确认。随时可以移除或吊销。
      </small>
      {view.targets.length ? (
        <ul className="external-integration-targets">
          {view.targets.map((target) => (
            <li key={target.path}>
              {target.agent}
              {target.status === 'skipped-foreign'
                ? '（已有同名 skill，跳过）'
                : view.installed
                  ? ' ✓'
                  : ''}
            </li>
          ))}
        </ul>
      ) : (
        <small className="external-hint">
          没有找到已知 Agent 的 skills 目录；仍会安装 pilion 命令。
        </small>
      )}
      {view.shimConflict ? (
        <small className="external-hint is-danger">
          {view.shimPath} 已存在且不是 Pilion 生成的，请先移走它再安装。
        </small>
      ) : null}
      {view.installed && !view.pathHasShimDir ? (
        <small className="external-hint">
          ~/.local/bin 不在 PATH 里，在 shell 配置中加入{' '}
          <code>export PATH="$HOME/.local/bin:$PATH"</code>。
        </small>
      ) : null}
      <div className="external-token-actions">
        <button
          className="secondary-button"
          disabled={busy || view.shimConflict}
          onClick={onInstall}
        >
          {busy ? '处理中…' : view.installed ? '重新安装' : '安装到 Agent'}
        </button>
        {view.installed ? (
          <button className="secondary-button" disabled={busy} onClick={onRemove}>
            移除
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

Inside `ExternalControlSection`, add state and render it **above** the `{on ? (...) : null}` block, outside it, so the button works while the switch is off:

```tsx
const [integration, setIntegration] = useState<AgentIntegrationView | undefined>(undefined);
const [integrationBusy, setIntegrationBusy] = useState(false);
useEffect(() => {
  if (isWindows) return;
  void window.pilion.external.integration
    .status()
    .then(setIntegration)
    .catch(() => undefined);
}, [isWindows, external.clients]);
function integrationAction(action: () => Promise<AgentIntegrationView>): void {
  setIntegrationBusy(true);
  void run(() => action().then(setIntegration)).finally(() => setIntegrationBusy(false));
}
```

```tsx
{
  isWindows ? null : (
    <AgentIntegrationSection
      view={integration}
      busy={integrationBusy}
      onInstall={() => integrationAction(() => window.pilion.external.integration.install())}
      onRemove={() => integrationAction(() => window.pilion.external.integration.remove())}
    />
  );
}
```

(`useEffect` depends on `external.clients` so a revoke from the list below refreshes the section.)

In the client list row, after `{client.name}` add `{client.kind === 'agent-integration' ? <span className="external-badge">集成</span> : null}`.

CSS (in the file holding `.external-conn-row`), using existing tokens only — check the file's variable names first (`grep -n "\-\-" <file> | head`):

```css
.external-integration {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}
.external-integration-targets {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 2px;
}
.external-hint.is-danger {
  color: var(--danger-text, var(--danger));
}
.external-badge {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
```

Replace the token names with the ones the stylesheet actually defines.

- [ ] **Step 4: Run** `pnpm vitest run tests/preferences-agent-integration.test.ts tests/preferences-browser.test.ts && pnpm typecheck && pnpm lint` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer tests/preferences-agent-integration.test.ts
git commit -m "feat(settings): 对外控制里新增「Agent 集成」区（安装到 Agent / 移除 / 冲突与 PATH 提示）"
```

---

### Task 8: Packaging — ship the skill as an extra resource

**Files:**

- Modify: `electron-builder.yml`
- Test: `tests/release-artifacts.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/release-artifacts.test.ts`)

```ts
it('ships the pilion-browser skill as an extra resource', () => {
  expect(config.extraResources).toContainEqual({
    from: 'skills/pilion-browser',
    to: 'skills/pilion-browser',
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/release-artifacts.test.ts` — Expected: FAIL.

- [ ] **Step 3: Edit `electron-builder.yml`** — after the `asar: true` line add:

```yaml
# pilion-browser skill：「安装到 Agent」从 process.resourcesPath/skills 拷到各 Agent 的 skills 目录。
# 注意：外部 CLI / MCP 都以 ELECTRON_RUN_AS_NODE=1 运行 App 可执行文件；若将来用 @electron/fuses
# 关闭 RunAsNode，`pilion` 命令与外部 MCP 会一起失效。
extraResources:
  - from: skills/pilion-browser
    to: skills/pilion-browser
```

- [ ] **Step 4: Run** `pnpm vitest run tests/release-artifacts.test.ts` — Expected: PASS.

- [ ] **Step 5: Verify the packaged layout once** (slow; skip signing/notarizing):

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build && pnpm exec electron-builder --mac dir --arm64 -c.mac.notarize=false
ls release/mac-arm64/Pilion.app/Contents/Resources/skills/pilion-browser
```

Expected: `SKILL.md  agents  references`. If `--mac dir` is not accepted, use `--dir`. Delete `release/mac-arm64` afterwards (`release/` is gitignored).

- [ ] **Step 6: Commit**

```bash
git add electron-builder.yml tests/release-artifacts.test.ts
git commit -m "build: 把 pilion-browser skill 打进 extraResources"
```

---

### Task 9: E2E — install, run the real `pilion` shim, remove

**Files:**

- Modify: `tests/electron.e2e.ts` (launch env + one new test placed right after the existing `'external CLI over the unix socket …'` test ~line 4676)

**Interfaces:**

- Consumes: everything above. The E2E launch must set `PILION_INTEGRATION_HOME` to a temp dir.

- [ ] **Step 1: Add the home override to the launch env.** In the `beforeAll`/first launch (line ~505) and every relaunch that uses `e2eEnv` (lines ~663, ~911, and any others — `grep -n "e2eEnv" tests/electron.e2e.ts`), the env object spreads `...e2eEnv`. Change `e2eEnv` itself:

```ts
const integrationHome = mkdtempSync(join(tmpdir(), 'pilion-e2e-home-'));
mkdirSync(join(integrationHome, '.claude', 'skills'), { recursive: true });
const e2eEnv = { PILION_E2E_NO_FOCUS: '1', PILION_INTEGRATION_HOME: integrationHome } as const;
```

(Import `mkdtempSync`, `mkdirSync` from `node:fs` and `tmpdir` from `node:os` if not already imported.)

- [ ] **Step 2: Write the test**

```ts
test('安装到 Agent installs a working pilion command and removing it revokes access', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  await mainPage.evaluate(() => window.pilion.settings.open());
  const settingsPage = await preferencesPage(application);
  const before = await mainPage.evaluate(() => window.pilion.getState().then((s) => s.activeTabId));

  // 先按现有用例 'settings UI creates an external client through the real inline form' 的方式切到对外控制所在的页签。
  await settingsPage.getByRole('button', { name: '安装到 Agent' }).click();
  await expect(settingsPage.getByRole('button', { name: '移除' })).toBeVisible();

  const shim = join(integrationHome, '.local', 'bin', 'pilion');
  expect(readFileSync(shim, 'utf8')).toContain('# pilion-shim v1');
  expect(statSync(join(profileDirectory, 'external', 'cli.token')).mode & 0o777).toBe(0o600);
  expect(
    readFileSync(join(integrationHome, '.claude', 'skills', 'pilion-browser', 'SKILL.md'), 'utf8'),
  ).toContain('name: pilion-browser');

  const pilion = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(
        shim,
        args,
        { env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 },
        (error, stdout, stderr) =>
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  const status = await pilion(['status']);
  expect(status.stdout).toMatch(/^handshake\tok/m);

  expect((await pilion(['skill'])).stdout.trimEnd().split('\n').at(-1)).toMatch(
    /^\[pilion:skill\] end of guide/,
  );

  const opened = await pilion(['new', 'https://example.com/']);
  expect(opened.code).toBe(0);
  const tabId = opened.stdout.trim();
  await expect
    .poll(async () => (await pilion(['read', '--tab', tabId])).stdout)
    .toMatch(EXAMPLE_BODY);
  const observed = JSON.parse(
    (await pilion(['observe', '--tab', tabId, '--json'])).stdout,
  ) as unknown[];
  expect(observed.length).toBeGreaterThan(0);

  // Agent 开的标签留在后台，用户当前选中的标签不变。
  expect(await mainPage.evaluate(() => window.pilion.getState().then((s) => s.activeTabId))).toBe(
    before,
  );

  await settingsPage.getByRole('button', { name: '移除' }).click();
  await expect(settingsPage.getByRole('button', { name: '安装到 Agent' })).toBeVisible();
  expect(existsSync(shim)).toBe(false);
  expect(existsSync(join(profileDirectory, 'external', 'cli.token'))).toBe(false);
  expect(existsSync(join(integrationHome, '.claude', 'skills', 'pilion-browser'))).toBe(false);
});
```

Before running, check the repo's real field name for the active tab in `AppState` (`grep -n "activeTabId" src/shared/contracts.ts`) and adjust `s.activeTabId` if it differs. `execFile`, `readFileSync`, `statSync`, `existsSync` need importing from `node:child_process` / `node:fs` if not already.

This test runs the shim with `PATH=/usr/bin:/bin` and **without** `PILION_EXTERNAL_*` env, proving the defaults baked into the shim are enough. In dev E2E the shim execs `process.execPath` (the Electron binary in `node_modules`) with `ELECTRON_RUN_AS_NODE=1` and the repo's `dist/main/main/external/pilion-cli.js`, which `pnpm test:e2e` builds first.

- [ ] **Step 3: Run only this test plus its neighbour**

Run: `pnpm build && pnpm exec playwright test tests/electron.e2e.ts -g "安装到 Agent|external CLI over the unix socket"`
Expected: both PASS. The repo's E2E has a focus guard (`scripts/e2e-focus-guard.sh`); follow whatever `pnpm test:e2e` does if a direct `playwright test` refuses to run.

- [ ] **Step 4: Commit**

```bash
git add tests/electron.e2e.ts
git commit -m "test(e2e): 安装到 Agent → 真实 pilion 子进程开标签/读页/观察 → 移除后清理"
```

---

### Task 10: Docs, changelog, full verification

**Files:**

- Modify: `README.md` (外部 CLI / MCP section, lines ~125-175), `docs/architecture.md` (对外 CLI / MCP 通道 section + module table lines ~46-47 + security bullet line ~195), `CHANGELOG.md` (top `Unreleased` section; read the file's format first)

- [ ] **Step 1: README** — at the start of `## 外部 CLI / MCP`, add a subsection:

```markdown
### 让终端 Agent 直接用（推荐）

在「设置 › 通用 › 对外控制」点 **安装到 Agent**。Pilion 会：

- 打开对外控制通道，签发一个名为「本机 Agent（CLI）」的客户端；
- 把它的 token 写进 `<userData>/external/cli.token`（`0600`）；
- 安装 `~/.local/bin/pilion` 命令（一个由 Pilion 生成、每次启动自动更新的 sh 脚本）；
- 把 `pilion-browser` skill 复制到本机已存在的 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`、`~/.gemini/skills`、`~/.trae/skills`、`~/.cursor/skills`。

之后在 Claude Code、Codex 等 Agent 里直接说「用浏览器打开 …」，Agent 会读到 skill、运行 `pilion skill` 拿到用法。也可以只装 skill：`npx skills add echoVic/pilion-browser`，第一次用时它会引导你安装 Pilion。

`pilion status` 检查连接；「移除」或在客户端列表里吊销「本机 Agent（CLI）」会删掉 token 文件、`pilion` 命令和复制出去的 skill。Pilion 只覆盖或删除自己生成的文件，已有的同名命令或 skill 不会被动。

**取舍**：`cli.token` 是一个文件凭证，本机任何以你身份运行的进程都能读到它。它和其他外部客户端权限相同：只能操作自己开的标签，改动页面的操作固定要你确认，不能执行页面 JS；用完可以一键移除或吊销。
```

Then in the existing "用命令行" paragraph replace the long `"<command>" "<应用资源>/…/pilion-cli.js"` examples with `pilion tabs`, `pilion new https://example.com`, `pilion read --tab <id>`, `pilion observe --tab <id>`, `pilion click --tab <id> --ref '<elementRef json>'`, `pilion screenshot --tab <id> -o shot.png`, keeping the sentence that manual clients can still inject `PILION_EXTERNAL_SOCKET` / `PILION_EXTERNAL_TOKEN` (the shim honours them). Replace the sentence "CLI **不再自动读取 userData 里的共享 token**……" with: "手动签发的客户端仍通过 `PILION_EXTERNAL_SOCKET` + `PILION_EXTERNAL_TOKEN`（或 `PILION_EXTERNAL_TOKEN_FILE`）注入；只有点过「安装到 Agent」，`pilion` 命令才会默认读取 `external/cli.token`。"

- [ ] **Step 2: architecture.md**
  - Module table: replace the `pilion-cli.ts` row with rows for `main/external/pilion-cli.ts`（入口）, `main/external/cli/`（参数、命令、`pilion skill` 指南）, `main/external/agent-integration.ts`（shim / token 文件 / skill 拷贝 / 对账）, `main/external/integration-wiring.ts`（安装/移除编排、吊销联动）.
  - In 对外 CLI / MCP 通道, add a paragraph describing: hello ack now `{"version"}`; the integration client (`kind: agent-integration`); the four files with markers; startup reconcile; revoke/delete → `onClientGone`; `PILION_INTEGRATION_HOME` test override.
  - Security bullet (~line 195): append "「安装到 Agent」会落一个 0600 的 `cli.token` 文件凭证，这是对 0.1.10「CLI 不读共享 token」决定的有意回退，仅在用户显式点击后存在，可一键移除/吊销。"

- [ ] **Step 3: CHANGELOG** — under the unreleased heading (create `## Unreleased` if none, matching the file's style):

```markdown
- 新增「安装到 Agent」：一键把 `pilion` 命令装到 `~/.local/bin`、把 `pilion-browser` skill 装进 Claude Code / Codex / Gemini CLI / Trae 等的 skills 目录，并签发专用凭证；可一键移除。
- `pilion` 命令新增 `skill`（给 Agent 的版本化用法指南）、`status`、`version`、`info`、`select`、`check`、`press`；`type` 支持 `--replace`。
- 仓库内新增 `skills/pilion-browser`，支持 `npx skills add echoVic/pilion-browser`。
```

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green. If `format:check` fails only on files this branch touched, run `pnpm exec prettier --write <those files>` and re-run.

Then the full E2E once: `pnpm test:e2e`. Expected: all pass. If an unrelated, previously flaky test fails, re-run that one test alone and record the result in the commit message body rather than editing it.

- [ ] **Step 5: Manual check on the real machine (dev build, real home)** — only with the user's go-ahead, because it writes into real `~/.claude/skills` etc.:

```bash
pnpm build && pnpm start
# 设置 › 对外控制 › 安装到 Agent
pilion status
pilion skill | tail -1
```

Expected: all status lines `ok`; sentinel line printed. Then 移除 and confirm `ls ~/.claude/skills/pilion-browser` is gone.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/architecture.md CHANGELOG.md
git commit -m "docs: 安装到 Agent、pilion 新命令与 cli.token 安全取舍"
```
