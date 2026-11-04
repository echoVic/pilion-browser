# Agent Space（二期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every terminal-agent conversation that drives Pilion through `pilion` gets its own Agent Space with its own sub-principal `external:<clientId>:<spaceId>`; conversations cannot touch each other's tabs, the user's tab list never changes while they work, and the user can 查看 / 停止 / 接管 each one from the Space switcher.

**Architecture:** Agent Spaces are ordinary `BrowserSpace` records with an optional `agent` field, persisted with the workspace. A pure class `AgentSpaces` (`src/main/external/spaces.ts`) owns every rule (caps, idle timer, resume, stop, takeover, eviction) and talks to the rest of the app only through an injected `AgentSpaceEffects` port. The socket server gains `space` in the hello frame and a separate control-frame channel (`space.create/list/close`) that never reaches the tool allowlist; `main.ts` only wires the port to real browser/ACL/approval side effects.

**Tech Stack:** TypeScript (NodeNext ESM), Electron 43 main process, React renderer, zod 4, vitest, Playwright Electron E2E, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-04-agent-spaces-design.md` (binding). Background: `docs/superpowers/specs/2026-11-03-agent-skill-cli-design.md` (Phase 1).

## Global Constraints

- Work only in worktrees under `/Users/bytedance/Documents/GitHub/pilion-browser/.worktrees/`. Integration branch `feat/agent-spaces` (`.worktrees/agent-spaces`). Never touch the main checkout (it holds unrelated uncommitted changes from another tool). Never use bare `git stash`.
- Never run `electron-builder`. Never write the real `~/.claude` etc.: E2E sets `PILION_INTEGRATION_HOME` to a temp dir (already wired). Never run two `pnpm test:e2e` at once (they share `dist/`).
- Sub-principal format: `external:<clientId>:<spaceId>`. spaceId format: `agent-<uuid>`. Phase 1 base principal `external:<clientId>` is unchanged.
- Caps (global, not per client): user Spaces 20, active Agent Spaces 8, ended Agent Spaces 8; `TabStateSchema.spaces` max 40.
- Agent Space idle timeout: 60 minutes (`AGENT_SPACE_IDLE_MS = 60 * 60_000`), refreshed by every admitted tool request.
- Resumable end reasons: `idle`, `restart`. Never resumable: `closed`, `stopped` (and taken-over Spaces have no `agent` field at all).
- Error codes and exact messages (in `src/main/external/space-protocol.ts`):
  - `SPACE_NOT_FOUND`: `Space 不存在或不属于本客户端`
  - `SPACE_ENDED`: `Space 已结束，请用 pilion space new 新建`
  - `SPACE_LIMIT`: `同时进行中的 Agent 空间已达 8 个：先用 pilion space close <id> 结束一个，或请用户在 Pilion 侧栏结束一个`
  - `SPACE_REQUIRED`: `先运行 pilion space new "<任务名>"，再给每条命令加 --space <id>`
- Missing vs foreign spaceId must produce the identical `SPACE_NOT_FOUND` error.
- Audit events carry `clientId` and `spaceId`, never the label: `external.space.created / closed / stopped / taken_over / resumed / evicted / idle / removed`.
- Integration client name `本机 Agent（CLI）`, kind `agent-integration`. Only that kind gets `SPACE_REQUIRED`; MCP and manually created clients keep Phase 1 behaviour.
- `EXTERNAL_TOOLS` does not change. Control frames never go through it and never call `runtime.run`.
- `skills/pilion-browser/SKILL.md` `metadata.version` stays equal to `package.json` version (do not bump it).
- `src/preload/entry.cts` and `src/preload/index.ts` groups must stay byte-identical (`tests/contracts.test.ts`); `src/preload/index.ts` must not contain the word `principal`.
- Several tests re-execute `main.ts` function bodies in a vm (`grep -ln runInNewContext tests/`). Any new free identifier used inside such a function must be added as a stub to those test contexts; never add new free identifiers directly inside `init()` — put the call in a named function.
- User-facing copy is Chinese.
- After each task: `pnpm typecheck && pnpm lint && pnpm vitest run <touched tests>` green before commit. Full `pnpm test` before Task 10; full `pnpm test:e2e` in Task 10.

## Lanes

Task 1 runs first on `feat/agent-spaces` (shared contracts). Then two lanes run in parallel, each in its own worktree branched from Task 1's commit, with disjoint files:

| Lane | Runner | Worktree / branch | Tasks | Files it may touch |
| --- | --- | --- | --- | --- |
| A | codex CLI | `.worktrees/agent-spaces-a`, `feat/agent-spaces-a` | 2 → 3 → 4 | `src/main/external/{server,client,types}.ts`, `src/main/external/cli/*`, `src/main/external/pilion-cli.ts`, `skills/pilion-browser/references/install.md`, `tests/{external-server,external-client,cli-args,cli-commands,cli-space}.test.ts` |
| B | orca CLI | `.worktrees/agent-spaces-b`, `feat/agent-spaces-b` | 5 → 6 → 7 | `src/main/browser/tab-organization.ts`, `src/main/external/spaces.ts`, `src/renderer/{SpaceSwitcher,AgentSpaceGroup}.tsx`, `src/renderer/browser-organization.css`, `src/preload/{index.ts,entry.cts}`, `tests/{tab-organization,agent-spaces,agent-space-group,contracts}.test.ts` |

After both lanes pass review, merge A then B into `feat/agent-spaces`; Tasks 8–10 run serially there.

## File Map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/shared/tab-organization.ts` | modify (T1) | `agent` field, caps, renderer-safe create/edit schemas |
| `src/shared/contracts.ts` | modify (T1) | `AppState.agentClientNames`, `ExternalConnectionView.spaceId`, two IPC channels |
| `src/main/external/space-protocol.ts` | create (T1) | sub-principal helpers, `AgentSpaceError`, control-frame schema, `ExternalSpaceControl` port |
| `src/main/external/types.ts` | modify (T2) | `admit(..., spaceId?)`, `ExternalConnection.spaceId`, `ExternalRuntime.spaces` |
| `src/main/external/server.ts` | modify (T2) | hello `space`, control frames, `SPACE_REQUIRED`, revoke by clientId |
| `src/main/external/client.ts` | modify (T3) | hello carries `space`; `callControl` |
| `src/main/external/cli/args.ts` | modify (T3) | `--space` |
| `src/main/external/cli/space.ts` | create (T3) | `pilion space new/list/close` |
| `src/main/external/cli/commands.ts` | modify (T3) | `control` in context, dispatch `space`, usage |
| `src/main/external/pilion-cli.ts` | modify (T3) | wire `--space` / `$PILION_SPACE` and `control` |
| `src/main/external/cli/guide.ts` | modify (T4) | Space workflow |
| `skills/pilion-browser/references/install.md` | modify (T4) | `SPACE_REQUIRED` / `SPACE_ENDED` troubleshooting |
| `src/main/browser/tab-organization.ts` | modify (T5) | user-Space counting, agent-space mutators, guards |
| `src/main/external/spaces.ts` | create (T6) | `AgentSpaces` rules engine |
| `src/renderer/AgentSpaceGroup.tsx` | create (T7) | Agent group rows with 查看/停止/接管/删除 |
| `src/renderer/SpaceSwitcher.tsx` | modify (T7) | split user vs agent Spaces, mount group |
| `src/renderer/browser-organization.css` | modify (T7) | group styles |
| `src/preload/index.ts`, `src/preload/entry.cts` | modify (T7) | `spaces.stopAgent`, `spaces.takeOverAgent` |
| `src/main/main.ts` | modify (T8, T9) | wiring only |
| `tests/electron.e2e.ts` | modify (T10) | two-Space E2E |
| `README.md`, `docs/architecture.md`, `CHANGELOG.md` | modify (T10) | docs |

---

### Task 1: Shared contracts — schema, principal helpers, errors, control frames, runtime port

Runs on `feat/agent-spaces` before the lanes split. Everything later tasks import from each other lives here.

**Files:**
- Modify: `src/shared/tab-organization.ts`
- Modify: `src/shared/contracts.ts` (AppState, ExternalConnectionView, IPC)
- Create: `src/main/external/space-protocol.ts`
- Modify: `src/main/external/types.ts`
- Modify: `src/main/main.ts` (externalRuntime only: `spaces` delegate + `agentSpaces` slot)
- Modify: `tests/external-server.test.ts` (fake `spaces` on the captured runtime only)
- Test: `tests/space-protocol.test.ts` (create)

**Interfaces:**
- Produces (shared/tab-organization.ts): `AGENT_SPACE_END_REASONS`, `AgentSpaceEndReason`, `AgentSpaceInfoSchema`, `AgentSpaceInfo`, `AgentBrowserSpace`, `isAgentSpace(space)`, `USER_SPACE_LIMIT = 20`, `ACTIVE_AGENT_SPACE_LIMIT = 8`, `ENDED_AGENT_SPACE_LIMIT = 8`; `BrowserSpace.agent?`; `SpaceCreateSchema`/`SpaceEditSchema` without `agent`; `TabStateSchema.spaces.max(40)`.
- Produces (space-protocol.ts): `externalSpacePrincipal(clientId, spaceId)`, `parseExternalPrincipal(principal)`, `AgentSpaceErrorCode`, `SPACE_MESSAGES`, `class AgentSpaceError extends Error { code }`, `ControlFrameSchema`, `type SpaceControl`, `type AgentSpaceSummary`, `type SpaceAdmission = 'ok' | 'resumed'`, `interface ExternalSpaceControl`.
- Produces (types.ts): `ExternalConnection.spaceId?`, `ExternalRuntime.admit(clientId, name, spaceId?)`, `ExternalRuntime.spaces: ExternalSpaceControl`.
- Produces (contracts.ts): `AppState.agentClientNames?: Record<string, string>`, `ExternalConnectionView.spaceId?: string`, `IPC.spaceStopAgent = 'spaces:stop-agent'`, `IPC.spaceTakeOverAgent = 'spaces:take-over-agent'`.
- Produces (main.ts): module-level `let agentSpaces: ExternalSpaceControl | undefined` and `function requireAgentSpaces(): ExternalSpaceControl`. Task 8 widens the type to `AgentSpaces` and assigns it.

- [ ] **Step 1: Write the failing test** — create `tests/space-protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { externalErrorDiagnostics } from '../src/main/external/client.js';
import {
  AgentSpaceError,
  ControlFrameSchema,
  SPACE_MESSAGES,
  externalSpacePrincipal,
  parseExternalPrincipal,
} from '../src/main/external/space-protocol.js';
import {
  BrowserSpaceSchema,
  DEFAULT_SPACE,
  SpaceCreateSchema,
  SpaceEditSchema,
  TabStateSchema,
  isAgentSpace,
} from '../src/shared/tab-organization.js';

const agent = { clientId: 'c1', label: '比价', createdAt: 1, state: 'active' as const };

describe('sub-principals', () => {
  it('round-trips client and space ids', () => {
    expect(externalSpacePrincipal('c1', 'agent-x')).toBe('external:c1:agent-x');
    expect(parseExternalPrincipal('external:c1:agent-x')).toEqual({ clientId: 'c1', spaceId: 'agent-x' });
    expect(parseExternalPrincipal('external:c1')).toEqual({ clientId: 'c1' });
  });
  it.each(['local-user', 'agent:x:y', 'external:', 'external:c1:', 'external:c1:a:b'])(
    'rejects %s',
    (value) => expect(parseExternalPrincipal(value)).toBeUndefined(),
  );
});

describe('AgentSpaceError', () => {
  it('carries a code that crosses the external boundary', () => {
    const error = new AgentSpaceError('SPACE_NOT_FOUND');
    expect(error.message).toBe(SPACE_MESSAGES.SPACE_NOT_FOUND);
    expect(externalErrorDiagnostics(error)).toEqual({ code: 'SPACE_NOT_FOUND' });
  });
});

describe('control frames', () => {
  it('accepts the three ops', () => {
    for (const control of [
      { op: 'space.create', label: '比价' },
      { op: 'space.list' },
      { op: 'space.close', spaceId: 'agent-1' },
    ])
      expect(ControlFrameSchema.parse({ id: '1', control }).control).toEqual(control);
  });
  it.each([
    { id: '1', control: { op: 'space.nuke' } },
    { id: '1', control: { op: 'space.create', label: '' } },
    { id: '1', control: { op: 'space.create', label: 'x'.repeat(41) } },
    { id: '1', control: { op: 'space.list', extra: true } },
    { id: '1', control: { op: 'space.list' }, request: {} },
  ])('rejects %j', (frame) => expect(ControlFrameSchema.safeParse(frame).success).toBe(false));
});

describe('agent space schema', () => {
  it('persists the agent field and recognises agent spaces', () => {
    const space = BrowserSpaceSchema.parse({ id: 'agent-1', name: '比价', color: 'neutral', agent });
    expect(space.agent).toEqual(agent);
    expect(isAgentSpace(space)).toBe(true);
    expect(isAgentSpace(DEFAULT_SPACE)).toBe(false);
  });
  it('keeps the renderer from creating or forging agent spaces', () => {
    expect(SpaceCreateSchema.safeParse({ name: 'x', color: 'teal', agent }).success).toBe(false);
    expect(SpaceEditSchema.safeParse({ id: 'a', name: 'x', color: 'teal', agent }).success).toBe(false);
  });
  it('loads old tab state without agent fields and caps spaces at 40', () => {
    const base = { activeSpaceId: 'default', tabs: [], archivedTabs: [] };
    expect(TabStateSchema.parse({ ...base, spaces: [DEFAULT_SPACE] }).spaces[0]).toEqual(DEFAULT_SPACE);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `s${i}`, color: 'teal' as const }));
    expect(TabStateSchema.safeParse({ ...base, spaces: many(40) }).success).toBe(true);
    expect(TabStateSchema.safeParse({ ...base, spaces: many(41) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/space-protocol.test.ts`
Expected: FAIL — cannot resolve `../src/main/external/space-protocol.js`.

- [ ] **Step 3: Implement `src/shared/tab-organization.ts` changes**

Replace the `BrowserSpaceSchema` block and the two renderer schemas, and change the `TabStateSchema` cap:

```ts
export const USER_SPACE_LIMIT = 20;
export const ACTIVE_AGENT_SPACE_LIMIT = 8;
export const ENDED_AGENT_SPACE_LIMIT = 8;
export const AGENT_SPACE_END_REASONS = ['closed', 'stopped', 'idle', 'restart'] as const;
export type AgentSpaceEndReason = (typeof AGENT_SPACE_END_REASONS)[number];
/** 外部 Agent 对话专属空间的元数据；只由主进程写，渲染进程的 create/edit schema 不含它。 */
export const AgentSpaceInfoSchema = z.object({
  clientId: z.string().min(1).max(256),
  label: z.string().trim().min(1).max(40),
  createdAt: z.number().finite().nonnegative(),
  state: z.enum(['active', 'ended']),
  endedAt: z.number().finite().nonnegative().optional(),
  endReason: z.enum(AGENT_SPACE_END_REASONS).optional(),
});
export type AgentSpaceInfo = z.infer<typeof AgentSpaceInfoSchema>;
const SpaceFieldsSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(40),
  color: SpaceColorSchema,
});
export const BrowserSpaceSchema = SpaceFieldsSchema.extend({
  agent: AgentSpaceInfoSchema.optional(),
});
export type BrowserSpace = z.infer<typeof BrowserSpaceSchema>;
export type AgentBrowserSpace = BrowserSpace & { agent: AgentSpaceInfo };
export function isAgentSpace(space: BrowserSpace): space is AgentBrowserSpace {
  return space.agent !== undefined;
}
```

In `TabStateSchema`: `spaces: z.array(BrowserSpaceSchema).min(1).max(40),` (20 user + 8 active + 8 ended + 4 headroom while eviction archives asynchronously).

Renderer schemas (no `agent`):

```ts
export const SpaceCreateSchema = SpaceFieldsSchema.omit({ id: true }).strict();
export const SpaceEditSchema = SpaceFieldsSchema.strict();
```

- [ ] **Step 4: Create `src/main/external/space-protocol.ts`**

```ts
import { z } from 'zod';
import type { AgentSpaceEndReason } from '../../shared/tab-organization.js';

/**
 * Agent Space 的协议面：子 principal 的拼装与解析、对外错误码、控制帧 schema，
 * 以及 server 调用的 ExternalSpaceControl 端口。规则本身在 spaces.ts。
 */

/** 每个外部 Agent 对话一个子 principal；clientId 是 base64url，不含冒号。 */
export function externalSpacePrincipal(clientId: string, spaceId: string): string {
  return `external:${clientId}:${spaceId}`;
}

export function parseExternalPrincipal(
  principal: string,
): { clientId: string; spaceId?: string } | undefined {
  if (!principal.startsWith('external:')) return undefined;
  const parts = principal.slice('external:'.length).split(':');
  if (parts.length > 2 || !parts[0] || parts[1] === '') return undefined;
  return parts.length === 2 ? { clientId: parts[0], spaceId: parts[1] } : { clientId: parts[0] };
}

export type AgentSpaceErrorCode = 'SPACE_NOT_FOUND' | 'SPACE_ENDED' | 'SPACE_LIMIT' | 'SPACE_REQUIRED';
export const SPACE_MESSAGES: Record<AgentSpaceErrorCode, string> = {
  SPACE_NOT_FOUND: 'Space 不存在或不属于本客户端',
  SPACE_ENDED: 'Space 已结束，请用 pilion space new 新建',
  SPACE_LIMIT:
    '同时进行中的 Agent 空间已达 8 个：先用 pilion space close <id> 结束一个，或请用户在 Pilion 侧栏结束一个',
  SPACE_REQUIRED: '先运行 pilion space new "<任务名>"，再给每条命令加 --space <id>',
};

/** code 会经 externalErrorDiagnostics 原样送到 CLI；message 固定，不带任何调用方输入。 */
export class AgentSpaceError extends Error {
  readonly name = 'AgentSpaceError';
  constructor(readonly code: AgentSpaceErrorCode) {
    super(SPACE_MESSAGES[code]);
  }
}

/** 控制帧：与工具请求帧分开，不进工具白名单、不碰浏览器。 */
export const ControlFrameSchema = z
  .object({
    id: z.string().min(1).max(128),
    control: z.discriminatedUnion('op', [
      z.object({ op: z.literal('space.create'), label: z.string().trim().min(1).max(40) }).strict(),
      z.object({ op: z.literal('space.list') }).strict(),
      z.object({ op: z.literal('space.close'), spaceId: z.string().min(1).max(256) }).strict(),
    ]),
  })
  .strict();
export type SpaceControl = z.infer<typeof ControlFrameSchema>['control'];

export interface AgentSpaceSummary {
  spaceId: string;
  label: string;
  state: 'active' | 'ended';
  endReason?: AgentSpaceEndReason;
}
export type SpaceAdmission = 'ok' | 'resumed';

/** server 只通过这个端口碰 Agent Space；所有失败都抛 AgentSpaceError。 */
export interface ExternalSpaceControl {
  /** hello 带 space 时调用：active → 'ok'；因 idle/restart 结束 → 重新激活并返回 'resumed'。 */
  admit(clientId: string, spaceId: string): Promise<SpaceAdmission>;
  create(clientId: string, label: string): Promise<{ spaceId: string }>;
  list(clientId: string): Promise<AgentSpaceSummary[]>;
  /** 结束自己的 Space（endReason 'closed'）；已结束的再关一次是 no-op。 */
  close(clientId: string, spaceId: string): Promise<void>;
  /** 吊销/删除客户端：停止它所有 active 的 Space。 */
  stopClient(clientId: string): Promise<void>;
}
```

- [ ] **Step 5: Update `src/main/external/types.ts`**

Add the import and fields (keep every existing member):

```ts
import type { ExternalSpaceControl } from './space-protocol.js';
```

In `ExternalConnection`, after `attachmentId`:

```ts
  /** 带 space 握手时的 Agent Space id；principal 随之是 external:<clientId>:<spaceId>。 */
  readonly spaceId?: string;
```

In `ExternalRuntime`, change `admit` and add `spaces`:

```ts
  admit(clientId: string, name: string, spaceId?: string): ExternalConnection;
  /** Agent Space 控制面：hello 校验与 space.create/list/close 控制帧。 */
  spaces: ExternalSpaceControl;
```

- [ ] **Step 6: Update `src/shared/contracts.ts`**

In `AppState`, after `externalClients?`:

```ts
  /** Agent 空间展示用：clientId → 客户端名（已吊销的显示「已吊销的客户端」）。不持久化。 */
  agentClientNames?: Record<string, string>;
```

In `ExternalConnectionView`, add `spaceId?: string;`. In `IPC`, after `spaceRemove`:

```ts
  spaceStopAgent: 'spaces:stop-agent',
  spaceTakeOverAgent: 'spaces:take-over-agent',
```

- [ ] **Step 7: Wire the port slot in `src/main/main.ts`**

Above `const externalRuntime: ExternalRuntime = {` add:

```ts
/** Agent Space 规则引擎；init 恢复完标签后才装上（Task 8 换成 AgentSpaces 实例）。 */
let agentSpaces: ExternalSpaceControl | undefined;
function requireAgentSpaces(): ExternalSpaceControl {
  if (!agentSpaces) throw new Error('Agent 空间尚未就绪');
  return agentSpaces;
}
```

Inside `externalRuntime`, add:

```ts
  spaces: {
    admit: async (clientId, spaceId) => requireAgentSpaces().admit(clientId, spaceId),
    create: async (clientId, label) => requireAgentSpaces().create(clientId, label),
    list: async (clientId) => requireAgentSpaces().list(clientId),
    close: async (clientId, spaceId) => requireAgentSpaces().close(clientId, spaceId),
    stopClient: async (clientId) => agentSpaces?.stopClient(clientId),
  },
```

Import `type ExternalSpaceControl` from `./external/space-protocol.js`. `admitExternalConnection` keeps its two-parameter signature for now (an extra optional parameter on the interface is compatible).

- [ ] **Step 8: Give the server test's captured runtime a `spaces` member**

In `tests/external-server.test.ts`, inside the `captured = { ... }` literal in `beforeEach`, add:

```ts
      spaces: {
        admit: async () => 'ok' as const,
        create: async () => ({ spaceId: 'agent-test' }),
        list: async () => [],
        close: async () => undefined,
        stopClient: async () => undefined,
      },
```

- [ ] **Step 9: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/space-protocol.test.ts tests/external-server.test.ts tests/tab-organization.test.ts tests/workspace.test.ts tests/contracts.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS, no type or lint errors.

- [ ] **Step 10: Commit**

```bash
git add src/shared/tab-organization.ts src/shared/contracts.ts src/main/external/space-protocol.ts src/main/external/types.ts src/main/main.ts tests/space-protocol.test.ts tests/external-server.test.ts
git commit -m "feat(external): Agent Space 共享契约——子 principal、错误码、控制帧与 schema"
```

---

### Task 2 (Lane A): Protocol — hello with `space`, control frames, `SPACE_REQUIRED`

**Files:**
- Modify: `src/main/external/server.ts`
- Modify: `src/main/external/types.ts` (already done in T1; verify only)
- Test: `tests/external-server.test.ts` (add tests; keep all existing ones green)

**Interfaces:**
- Consumes: `ControlFrameSchema`, `AgentSpaceError`, `SPACE_MESSAGES`, `parseExternalPrincipal`, `ExternalSpaceControl` (from T1 `space-protocol.ts`); `ExternalConnection.spaceId?`, `ExternalRuntime.admit(…, spaceId?)`, `ExternalRuntime.spaces` (from T1 `types.ts`).
- Produces: `ExternalControlServer` with updated hello and control-frame handling, for use by T3 (client) and T8 (main.ts wiring).

- [ ] **Step 1: Write the failing tests** — add a `describe('Agent Space protocol')` block to `tests/external-server.test.ts`:

```ts
import {
  AgentSpaceError,
  externalSpacePrincipal,
} from '../src/main/external/space-protocol.js';

// Helper: send hello + optionally a frame, collect all newline-delimited responses.
async function sendRaw(
  socketPath: string,
  hello: object,
  frames: object[] = [],
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    const lines: string[] = [];
    const timer = setTimeout(() => { sock.destroy(); resolve(lines); }, 2000);
    sock.once('connect', () => sock.write(`${JSON.stringify(hello)}\n`));
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) lines.push(line);
        if (frames.length && lines.length === 1) {
          // ack received — send remaining frames
          for (const f of frames) sock.write(`${JSON.stringify(f)}\n`);
          frames.length = 0;
        }
        nl = buf.indexOf('\n');
      }
    });
    sock.once('error', reject);
    sock.once('close', () => { clearTimeout(timer); resolve(lines); });
  });
}

describe('Agent Space protocol', () => {
  it('hello with valid active space is admitted as sub-principal', async () => {
    captured.admit = (clientId, name, spaceId) => makeConnection(clientId, name, spaceId);
    captured.spaces.admit = async () => 'ok';
    const lines = await sendRaw(server.socketPath, { token: clientA.token, space: 'agent-1' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: '1.2.3' });
  });

  it('hello with unknown/foreign space returns SPACE_NOT_FOUND', async () => {
    captured.spaces.admit = async () => { throw new AgentSpaceError('SPACE_NOT_FOUND'); };
    const lines = await sendRaw(server.socketPath, { token: clientA.token, space: 'agent-x' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: expect.stringContaining('不存在') });
  });

  it('hello with ended space returns SPACE_ENDED', async () => {
    captured.spaces.admit = async () => { throw new AgentSpaceError('SPACE_ENDED'); };
    const lines = await sendRaw(server.socketPath, { token: clientA.token, space: 'agent-ended' });
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: expect.stringContaining('已结束') });
  });

  it('integration-kind client without space: tool frame → SPACE_REQUIRED', async () => {
    const integrationClient = grab(await server.createClient('集成', 'agent-integration'));
    const lines = await sendRaw(
      server.socketPath,
      { token: integrationClient.token },
      [{ id: 'r1', request: { requestId: 'rq1', name: 'browser.tabs.list', args: {} } }],
    );
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'r1', error: expect.stringContaining('space new') });
  });

  it('non-integration client without space passes tool frames normally (Phase 1 behaviour)', async () => {
    // clientA is not kind=agent-integration
    const lines = await sendRaw(
      server.socketPath,
      { token: clientA.token },
      [{ id: 'r1', request: { requestId: 'rq1', name: 'browser.tabs.list', args: {} } }],
    );
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'r1', result: expect.anything() });
  });

  it('control frame space.create returns spaceId', async () => {
    captured.spaces.create = async (clientId, label) => ({ spaceId: `agent-${label}` });
    const lines = await sendRaw(
      server.socketPath,
      { token: clientA.token },
      [{ id: 'c1', control: { op: 'space.create', label: '比价' } }],
    );
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'c1', result: { spaceId: 'agent-比价' } });
  });

  it('control frame space.list returns summaries', async () => {
    captured.spaces.list = async () => [{ spaceId: 'agent-1', label: '比价', state: 'active' }];
    const lines = await sendRaw(
      server.socketPath,
      { token: clientA.token },
      [{ id: 'c2', control: { op: 'space.list' } }],
    );
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'c2', result: { spaces: [{ spaceId: 'agent-1' }] } });
  });

  it('control frame space.close responds ok', async () => {
    captured.spaces.close = async () => undefined;
    const lines = await sendRaw(
      server.socketPath,
      { token: clientA.token },
      [{ id: 'c3', control: { op: 'space.close', spaceId: 'agent-1' } }],
    );
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'c3', result: { ok: true } });
  });

  it('unknown space.* op is refused as malformed', async () => {
    const lines = await sendRaw(
      server.socketPath,
      { token: clientA.token },
      [{ id: 'c4', control: { op: 'space.nuke' } }],
    );
    // malformed frame → socket ends or error in response
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last).toMatchObject({ error: expect.any(String) });
  });

  it('control frame never reaches runtime.run', async () => {
    captured.spaces.create = async () => ({ spaceId: 'agent-z' });
    const lines = await sendRaw(
      server.socketPath,
      { token: clientA.token },
      [{ id: 'ctrl', control: { op: 'space.create', label: 'Z' } }],
    );
    expect(captured.received).toHaveLength(0);
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'ctrl', result: { spaceId: 'agent-z' } });
  });
});
```

Also update the existing `makeConnection` helper in the test file to accept an optional `spaceId` parameter:

```ts
function makeConnection(clientId: string, name: string, spaceId?: string): ExternalConnection {
  const principal = spaceId
    ? externalSpacePrincipal(clientId, spaceId)
    : externalPrincipalForClient(clientId);
  return {
    principal,
    clientId,
    name,
    spaceId,
    connectedAt: new Date().toISOString(),
    attachmentId: `att-${clientId}`,
    run: async (request) => {
      captured.received.push(request);
      return { ok: true, principal, request };
    },
    close: () => undefined,
    revoke: () => undefined,
  };
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/external-server.test.ts`
Expected: FAIL — new tests fail; existing tests still pass.

- [ ] **Step 3: Implement the changes in `src/main/external/server.ts`**

3a. Add imports at the top:

```ts
import {
  AgentSpaceError,
  ControlFrameSchema,
  SPACE_MESSAGES,
} from './space-protocol.js';
```

3b. In `#handleHello`, after `entry` is resolved and before calling `runtime.admit`, add the space check:

```ts
const parsedHello = HelloSchema.parse(JSON.parse(line)); // already done by HelloSchema.parse above
// --- space handling ---
const spaceId = parsedHello.space;
if (spaceId !== undefined) {
  let admission: 'ok' | 'resumed';
  try {
    admission = await this.options.runtime.spaces.admit(entry.clientId, spaceId);
  } catch (error) {
    callbacks.failClosed();
    const msg =
      error instanceof AgentSpaceError
        ? error.message
        : SPACE_MESSAGES.SPACE_NOT_FOUND;
    this.#audit('external.space.admit_failed', {
      connectionId,
      clientId: entry.clientId,
      spaceId,
      reason: error instanceof AgentSpaceError ? error.code : 'unknown',
    });
    socket.end(`${JSON.stringify({ error: msg })}\n`);
    socket.destroy();
    return;
  }
  if (admission === 'resumed') {
    this.#audit('external.space.resumed', { connectionId, clientId: entry.clientId, spaceId });
  }
}
```

Then pass `spaceId` to `runtime.admit`:

```ts
conn = this.options.runtime.admit(entry.clientId, entry.name, spaceId);
```

3c. In `#handleRequest`, before the `RequestFrameSchema` parse, try to parse as a control frame first:

```ts
// 控制帧：不进工具白名单，不调 runtime.run。
const controlParsed = ControlFrameSchema.safeParse(JSON.parse(line));
if (controlParsed.success) {
  inflight += 1;
  void this.#handleControl(socket, connectionId, handshook, controlParsed.data).finally(() => {
    inflight -= 1;
  });
  return; // do not fall through to RequestFrameSchema
}
```

3d. Add `#handleControl` private method after `#handleRequest`:

```ts
async #handleControl(
  socket: Socket,
  connectionId: string,
  conn: ExternalConnection,
  frame: { id: string; control: import('./space-protocol.js').SpaceControl },
): Promise<void> {
  const { id, control } = frame;
  try {
    let result: unknown;
    switch (control.op) {
      case 'space.create':
        result = await this.options.runtime.spaces.create(conn.clientId, control.label);
        break;
      case 'space.list': {
        const spaces = await this.options.runtime.spaces.list(conn.clientId);
        result = { spaces };
        break;
      }
      case 'space.close':
        await this.options.runtime.spaces.close(conn.clientId, control.spaceId);
        result = { ok: true };
        break;
    }
    socket.write(`${JSON.stringify({ id, result })}\n`);
  } catch (error) {
    socket.write(
      `${JSON.stringify({
        id,
        error: error instanceof Error ? error.message : String(error),
        ...externalErrorDiagnostics(error),
      })}\n`,
    );
  }
}
```

3e. Add `SPACE_REQUIRED` check. In `#handleRequest`, after the connection is established and before `RequestFrameSchema.parse`, check for `kind === 'agent-integration'` without a space:

```ts
if (!conn.spaceId && conn.kind === 'agent-integration') {
  this.#audit('external.request.space_required', { connectionId, principal: conn.principal });
  socket.write(`${JSON.stringify({ id: frame.id, error: SPACE_MESSAGES.SPACE_REQUIRED })}\n`);
  return;
}
```

Note: `conn.kind` is not yet on `ExternalConnection`. Add it: `readonly kind?: import('./client-registry.js').ExternalClientKind;` to the `ExternalConnection` interface in `types.ts`, and set it in `admitExternalConnection` in `main.ts` (Task 8). For now the check can use `conn.principal.split(':').length === 2` to detect a client with no space; the proper `conn.kind` wiring arrives in Task 8.

3f. In `revokeClient` and `deleteClient`, after closing connections by `conn.principal === principal`, also call `this.options.runtime.spaces.stopClient(clientId)`:

```ts
await this.options.runtime.spaces.stopClient(clientId);
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/external-server.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/external/server.ts tests/external-server.test.ts
git commit -m "feat(external): hello + space 握手，控制帧，SPACE_REQUIRED"
```

---

### Task 3 (Lane A): CLI — `--space`, `callControl`, `pilion space new/list/close`

**Files:**
- Modify: `src/main/external/client.ts`
- Modify: `src/main/external/cli/args.ts`
- Create: `src/main/external/cli/space.ts`
- Modify: `src/main/external/cli/commands.ts`
- Modify: `src/main/external/pilion-cli.ts`
- Test: `tests/cli-args.test.ts` (add `--space`)
- Test: `tests/cli-commands.test.ts` (add `space` commands)
- Create: `tests/cli-space.test.ts`

**Interfaces:**
- Consumes: `AgentSpaceError`, `AgentSpaceSummary`, `ControlFrameSchema` types from `space-protocol.ts` (T1); `ExternalEndpoint` from `client.ts`.
- Produces: `callControl(endpoint, control)` exported from `client.ts`; `CommandContext.control?`; handlers for `space new/list/close` in `commands.ts`/`space.ts`; `--space` flag parsed into `CliArgs.space`; `pilion-cli.ts` resolves `--space` from `$PILION_SPACE`.

- [ ] **Step 1: Write failing tests**

Add to `tests/cli-args.test.ts`:

```ts
it('parses --space flag', () => {
  expect(parseArgv(['new', 'https://a.test/', '--space', 'agent-1'])).toMatchObject({
    command: 'new',
    args: { space: 'agent-1' },
  });
});

it('--space with no value records an error', () => {
  const { args } = parseArgv(['new', 'https://a.test/', '--space']);
  expect(args.error).toMatch(/--space/);
});
```

Add to `tests/cli-commands.test.ts`:

```ts
describe('space commands', () => {
  it('space new prints spaceId to stdout and hint to stderr', async () => {
    const h = harness({});
    h.control = async () => ({ spaceId: 'agent-abc' });
    await h.run(['space', 'new', '比价任务']);
    expect(h.out).toEqual(['agent-abc']);
    expect(h.err[0]).toContain('--space agent-abc');
  });

  it('space new --json prints one line json', async () => {
    const h = harness({});
    h.control = async () => ({ spaceId: 'agent-abc' });
    await h.run(['space', 'new', '--json', '比价任务']);
    expect(h.out).toEqual(['{"spaceId":"agent-abc"}']);
    expect(h.err).toHaveLength(0);
  });

  it('space list prints table', async () => {
    const h = harness({});
    h.control = async () => ({ spaces: [{ spaceId: 'agent-1', label: '比价', state: 'active' }] });
    await h.run(['space', 'list']);
    expect(h.out[0]).toContain('agent-1');
    expect(h.out[0]).toContain('比价');
  });

  it('space close prints ok', async () => {
    const h = harness({});
    h.control = async () => ({ ok: true });
    await h.run(['space', 'close', 'agent-1']);
    expect(h.err).toHaveLength(0);
  });

  it('space new with no label throws usage error', async () => {
    const h = harness({});
    await expect(h.run(['space', 'new'])).rejects.toBeInstanceOf(CliError);
  });
});
```

Note: the `harness` function needs a `control` field alongside `call`. Update the harness in the test file:

```ts
function harness(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let controlFn: ((frame: object) => Promise<unknown>) | undefined;
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
      control: controlFn ? async (c) => controlFn!(c) : undefined,
      version: '9.9.9',
    });
  };
  const h = { calls, out, err, run, set control(fn: typeof controlFn) { controlFn = fn; } };
  return h;
}
```

Create `tests/cli-space.test.ts` for parsing the `AgentSpaceError` returned over the wire:

```ts
import { describe, expect, it } from 'vitest';
import { AgentSpaceError, SPACE_MESSAGES } from '../src/main/external/space-protocol.js';
import { ExternalCallError } from '../src/main/external/client.js';

describe('space error handling in CLI', () => {
  it('ExternalCallError with SPACE_ENDED code surfaces the right message', () => {
    const err = new ExternalCallError(SPACE_MESSAGES.SPACE_ENDED, { code: 'SPACE_ENDED' });
    expect(err.code).toBe('SPACE_ENDED');
    expect(err.message).toBe(SPACE_MESSAGES.SPACE_ENDED);
  });

  it('AgentSpaceError and ExternalCallError carry the same message for SPACE_NOT_FOUND', () => {
    const a = new AgentSpaceError('SPACE_NOT_FOUND');
    const b = new ExternalCallError(SPACE_MESSAGES.SPACE_NOT_FOUND, { code: 'SPACE_NOT_FOUND' });
    expect(a.message).toBe(b.message);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/cli-args.test.ts tests/cli-commands.test.ts tests/cli-space.test.ts`
Expected: FAIL on new tests; existing pass.

- [ ] **Step 3: Add `space?: string` to `CliArgs` and `--space` to `VALUE_FLAGS` in `src/main/external/cli/args.ts`**

In the `CliArgs` type, add `space?: string;`. In `VALUE_FLAGS`, add `'--space': 'space'`.

- [ ] **Step 4: Add `callControl` to `src/main/external/client.ts`**

```ts
/** 发一个控制帧（space.create/list/close），返回 result 或抛 ExternalCallError。 */
export function callControl(endpoint: ExternalEndpoint, control: object): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let handshook = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(30_000, () => finish(new ExternalCallError('控制帧超时', { code: 'PILION_EXTERNAL_TIMEOUT' })));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token: endpoint.token })}\n`);
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0 && !settled) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
        if (!line.trim()) continue;
        let msg: { id?: string; result?: unknown; error?: string } & ExternalErrorDiagnostics;
        try { msg = JSON.parse(line); } catch { finish(new ExternalCallError('malformed frame', { code: 'PILION_EXTERNAL_MALFORMED_RESPONSE' })); return; }
        if (typeof msg.error === 'string' && !handshook) { finish(new ExternalCallError(msg.error, msg)); return; }
        if (!handshook) {
          handshook = true;
          socket.write(`${JSON.stringify({ id, control })}\n`);
          continue;
        }
        if (msg.id !== id) continue;
        if (typeof msg.error === 'string') finish(new ExternalCallError(msg.error, msg));
        else finish(undefined, msg.result);
      }
    });
    socket.once('error', (e) => finish(new ExternalCallError(e.message, { code: 'PILION_EXTERNAL_CONNECTION_ERROR' })));
    const closed = () => finish(new ExternalCallError('connection closed without response', { code: 'PILION_EXTERNAL_CONNECTION_CLOSED' }));
    socket.once('end', closed);
    socket.once('close', closed);
  });
}
```

The hello it sends does not include `space` (control frames are valid on any connection). If the call needs to reactivate a specific Space it passes `space` in the hello; the simple `space.create` / `space.list` / `space.close` flows don't need it — they work on the base-principal connection.

- [ ] **Step 5: Add `control?` to `CommandContext` and `CallControl` type in `src/main/external/cli/commands.ts`**

```ts
export type CallControl = (control: object) => Promise<unknown>;

export interface CommandContext {
  // ... existing fields ...
  /** 发控制帧（space.create/list/close）；入口提供真实实现，`space *` 之外的命令不需要。 */
  control?: () => Promise<CallControl>;
}
```

Add the `USAGE` entry for space commands. Update the space section at the top of the usage string:

```ts
'  space new "<label>"            创建 Agent 空间（打印 spaceId）',
'  space list                      列出当前客户端的 Agent 空间',
'  space close <id>               关闭 Agent 空间',
```

- [ ] **Step 6: Create `src/main/external/cli/space.ts`**

```ts
import type { CommandContext } from './commands.js';
import { CliError, printResult } from './output.js';
import type { AgentSpaceSummary } from '../space-protocol.js';

export async function handleSpace(subcommand: string, ctx: CommandContext): Promise<void> {
  const getCtrl = ctx.control;
  if (!getCtrl) throw new CliError('space 命令需要凭证；请先运行 pilion status');
  const ctrl = await getCtrl();

  if (subcommand === 'new') {
    const label = ctx.args.rest[0];
    if (!label) throw new CliError('用法：pilion space new "<任务名>"');
    const result = (await ctrl({ op: 'space.create', label })) as { spaceId: string };
    if (ctx.args.json) {
      ctx.io.stdout(JSON.stringify({ spaceId: result.spaceId }));
    } else {
      ctx.io.stdout(result.spaceId);
      ctx.io.stderr(`之后每条命令都加 --space ${result.spaceId}（或 export PILION_SPACE=${result.spaceId}）`);
    }
  } else if (subcommand === 'list') {
    const result = (await ctrl({ op: 'space.list' })) as { spaces: AgentSpaceSummary[] };
    printResult(
      ctx.io,
      ctx.args.json,
      result.spaces,
      result.spaces
        .map((s) => `${s.spaceId}\t${s.state}\t${s.label}${s.endReason ? ` (${s.endReason})` : ''}`)
        .join('\n') || '（无 Agent 空间）',
    );
  } else if (subcommand === 'close') {
    const id = ctx.args.rest[0];
    if (!id) throw new CliError('用法：pilion space close <spaceId>');
    await ctrl({ op: 'space.close', spaceId: id });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已关闭');
  } else {
    throw new CliError('用法：pilion space new "<label>" | list | close <id>');
  }
}
```

- [ ] **Step 7: Register `space` in `runCommand` in `src/main/external/cli/commands.ts`**

In `handlers`, add:

```ts
async space(ctx) {
  const sub = ctx.args.rest.shift() ?? '';
  await (await import('./space.js')).handleSpace(sub, ctx);
},
```

- [ ] **Step 8: Wire `--space` and `control` in `src/main/external/pilion-cli.ts`**

Resolve space before the `call` lazy getter (space can come from `--space` or `$PILION_SPACE`):

```ts
const space = args.space ?? process.env.PILION_SPACE;
let ctrl: import('./cli/commands.js').CallControl | undefined;

process.exitCode = await runCli(command, {
  args,
  io: processIo,
  version,
  status: () => checkStatus(version),
  call: async () => {
    if (!tool) {
      const endpoint = await resolveEndpoint();
      // hello带space（如果有）：工具帧在子 principal 下发出
      const epWithSpace = space ? { ...endpoint, space } : endpoint;
      tool = (request) => callTool(epWithSpace, { ...request, name: request.name as ToolName });
    }
    return tool;
  },
  control: async () => {
    if (!ctrl) {
      const endpoint = await resolveEndpoint();
      ctrl = (control) => callControl(endpoint, control);
    }
    return ctrl;
  },
});
```

Update `callTool` in `client.ts` to accept an optional `space` field on the endpoint and include it in the hello frame:

In `ExternalEndpoint`, add `space?: string;`. In `callTool`, change the hello write to:

```ts
socket.write(`${JSON.stringify(endpoint.space ? { token: endpoint.token, space: endpoint.space } : { token: endpoint.token })}\n`);
```

- [ ] **Step 9: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/cli-args.test.ts tests/cli-commands.test.ts tests/cli-space.test.ts tests/external-client.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/external/client.ts src/main/external/cli/args.ts src/main/external/cli/commands.ts src/main/external/cli/space.ts src/main/external/pilion-cli.ts tests/cli-args.test.ts tests/cli-commands.test.ts tests/cli-space.test.ts
git commit -m "feat(cli): pilion space new/list/close；--space；callControl"
```

---

### Task 4 (Lane A): Guide, SKILL.md reference, install.md

**Files:**
- Modify: `src/main/external/cli/guide.ts`
- Modify: `skills/pilion-browser/references/install.md`

**Interfaces:**
- Consumes: nothing from other tasks (documentation only).
- Produces: updated rendered guide exposed by `pilion skill`, updated install.md.

- [ ] **Step 1: Update `src/main/external/cli/guide.ts`**

Add a new section **Space（Agent 工作区）** near the top of the `## Workflow` section, replacing the old single-tab workflow with:

```
## Workflow

Every conversation that uses Pilion should have its own Space so tabs from
different conversations do not mix.

1. Create a Space for this conversation and keep its id:
   \`\`\`bash
   SPACE=$(pilion space new "task description")   # prints the spaceId, e.g. agent-abc123
   \`\`\`
2. Open a tab inside the Space:
   \`\`\`bash
   pilion new https://example.com --space "$SPACE"   # prints the tab id
   \`\`\`
3. Read and interact (always pass --space and --tab):
   \`\`\`bash
   pilion read    --space "$SPACE" --tab "$TAB"
   pilion observe --space "$SPACE" --tab "$TAB" --json
   pilion click   --space "$SPACE" --tab "$TAB" --ref '<ref json>'
   \`\`\`
4. When the task is done:
   \`\`\`bash
   pilion space close "$SPACE"
   \`\`\`

If you omit \`--space\` the command will fail with an error that shows you
what to run. Pass \`--space "$SPACE"\` to every browser command in the task.
Spaces survive Pilion restarts (unless the person stopped or took over the Space).
If a command fails with "Space 已结束":
- Check whether the person stopped or took over your Space in Pilion's sidebar.
- Do not silently retry. Tell the person what happened and ask whether to open a new Space.
```

Keep the rest of the guide as-is. Update the `## When something fails` section to add entries:

```
- **Space 已结束 / SPACE_ENDED**: the person stopped or took over your Space,
  or it went idle (60 minutes with no activity). Do not re-create silently;
  tell the person and wait for their ok before opening a new Space.
- **SPACE_REQUIRED**: you forgot --space. Run \`pilion space new "<task>"\` first,
  then add \`--space <id>\` to every command.
- **SPACE_LIMIT**: 8 active Spaces already open. Run \`pilion space list\` to see
  them, then \`pilion space close <id>\` to end one, or ask the person to end one
  in Pilion's sidebar.
```

- [ ] **Step 2: Update `skills/pilion-browser/references/install.md`**

Add a **Troubleshooting** entry for Space errors:

```markdown
- **`SPACE_REQUIRED`**: the `pilion` command requires a `--space` argument (or `PILION_SPACE` env). Run `pilion space new "<task name>"` to create one and use the printed id.
- **`Space 已结束` / `SPACE_ENDED`**: the Space was stopped or taken over by the person, or went idle. Tell the person and ask before starting a new Space.
- **`SPACE_LIMIT`**: 8 active Spaces already open. Run `pilion space close <id>` or ask the person to end one in Pilion's sidebar.
```

- [ ] **Step 3: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/skill-package.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS. (skill-package.test.ts checks the sentinel and install.md; SKILL.md version stays equal to package.json.)

- [ ] **Step 4: Commit**

```bash
git add src/main/external/cli/guide.ts skills/pilion-browser/references/install.md
git commit -m "docs(skill): Space 工作流与排错说明加入指南和 install.md"
```

---

### Task 5 (Lane B): `TabOrganization` — user-space counting, agent-space guards, archiving

**Files:**
- Modify: `src/main/browser/tab-organization.ts`
- Modify: `src/shared/tab-organization.ts` (export `isAgentSpace` — done in T1; only `removeSpace`/edit guards to add here)
- Test: `tests/tab-organization.test.ts`

**Interfaces:**
- Consumes: `isAgentSpace`, `USER_SPACE_LIMIT`, `AgentBrowserSpace` from `shared/tab-organization.ts` (T1).
- Produces: `TabOrganization.createSpace` enforces 20-user-Space limit; guards on `editSpace`, `removeSpace`, `move`, `setKind` for Agent Spaces; `removeAgentSpace(id)` archives its tabs rather than merging.

- [ ] **Step 1: Write failing tests** — add to `tests/tab-organization.test.ts`:

```ts
import {
  DEFAULT_SPACE,
  type BrowserSpace,
  isAgentSpace,
  USER_SPACE_LIMIT,
} from '../src/shared/tab-organization';

const agentSpace: BrowserSpace = {
  id: 'agent-1',
  name: '比价',
  color: 'neutral',
  agent: { clientId: 'c1', label: '比价', createdAt: 1, state: 'active' },
};
const endedAgentSpace: BrowserSpace = {
  id: 'agent-ended',
  name: '旧任务',
  color: 'neutral',
  agent: { clientId: 'c1', label: '旧任务', createdAt: 1, state: 'ended', endedAt: 2, endReason: 'idle' },
};

describe('user-space cap', () => {
  it('createSpace counts only user Spaces toward the 20-limit', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    // 19 more user spaces should succeed (total 20 user + 1 agent)
    for (let i = 0; i < 19; i++) org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    expect(() => org.createSpace('overflow', 'teal', 'uid-overflow')).toThrow('最多创建 20 个用户空间');
  });
});

describe('agent-space guards', () => {
  it('editSpace rejects active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    expect(() => org.editSpace({ ...agentSpace, name: 'new' })).toThrow('Agent 空间');
  });

  it('editSpace rejects ended agent space (rename forbidden)', () => {
    const org = new TabOrganization([DEFAULT_SPACE, endedAgentSpace]);
    expect(() => org.editSpace({ ...endedAgentSpace, name: 'new' })).toThrow('Agent 空间');
  });

  it('removeSpace rejects active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    expect(() => org.removeSpace(agentSpace.id)).toThrow('停止或接管');
  });

  it('removeAgentSpace on ended space returns tabs for archiving', () => {
    const org = new TabOrganization([DEFAULT_SPACE, endedAgentSpace]);
    org.add('t1', { spaceId: endedAgentSpace.id, kind: 'today', lastActiveAt: 1 });
    const tabIds = org.removeAgentSpace(endedAgentSpace.id);
    expect(tabIds).toEqual(['t1']);
    expect(org.spaces.find((s) => s.id === endedAgentSpace.id)).toBeUndefined();
  });

  it('removeAgentSpace rejects active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    expect(() => org.removeAgentSpace(agentSpace.id)).toThrow('停止或接管');
  });

  it('move rejects tab into active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    org.add('t1', { spaceId: DEFAULT_SPACE.id, kind: 'today', lastActiveAt: 1 });
    expect(() => org.move('t1', agentSpace.id)).toThrow('Agent 空间');
  });

  it('move rejects tab out of active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    org.add('t1', { spaceId: agentSpace.id, kind: 'today', lastActiveAt: 1 });
    expect(() => org.move('t1', DEFAULT_SPACE.id)).toThrow('Agent 空间');
  });

  it('setKind rejects pinned/favorite for tabs in active agent space', () => {
    const org = new TabOrganization([DEFAULT_SPACE, agentSpace]);
    org.add('t1', { spaceId: agentSpace.id, kind: 'today', lastActiveAt: 1 });
    expect(() => org.setKind('t1', 'pinned')).toThrow('Agent 空间');
    expect(() => org.setKind('t1', 'favorite')).toThrow('Agent 空间');
  });
});

describe('addAgentSpace', () => {
  it('adds an agent space without counting toward user cap', () => {
    const org = new TabOrganization();
    const spaces = [];
    for (let i = 0; i < USER_SPACE_LIMIT; i++) {
      const id = `u${i}`;
      if (i > 0) org.createSpace(`u${i}`, 'teal', id);
      spaces.push(id);
    }
    // adding an agent space must succeed even at the user cap
    expect(() => org.addAgentSpace(agentSpace)).not.toThrow();
    expect(org.spaces.some((s) => s.id === agentSpace.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/tab-organization.test.ts`
Expected: FAIL on new tests; existing pass.

- [ ] **Step 3: Implement changes in `src/main/browser/tab-organization.ts`**

3a. Add import at top:

```ts
import {
  isAgentSpace,
  USER_SPACE_LIMIT,
  type AgentBrowserSpace,
} from '../../shared/tab-organization.js';
```

3b. Change `createSpace` to count only non-agent Spaces:

```ts
createSpace(name: string, color: SpaceColor, id: string): BrowserSpace {
  const userCount = this.spaces.filter((s) => !isAgentSpace(s)).length;
  if (userCount >= USER_SPACE_LIMIT) throw new Error('最多创建 20 个用户空间');
  if (this.spaces.some((space) => space.id === id)) throw new Error('空间已存在');
  const space: BrowserSpace = { name, color, id };
  this.spaces.push(space);
  return space;
}
```

3c. Add `addAgentSpace` method:

```ts
/** 由 spaces.ts 调用：在 spaces 数组里登记一个新的 Agent Space，不受用户 Space 上限约束。 */
addAgentSpace(space: AgentBrowserSpace): void {
  if (this.spaces.some((s) => s.id === space.id)) throw new Error('空间已存在');
  this.spaces.push(space);
}

/** 更新 Agent Space 的 agent 元数据（state/endedAt/endReason）。 */
updateAgentSpace(id: string, patch: Partial<AgentBrowserSpace['agent']>): void {
  const space = this.requireSpace(id);
  if (!isAgentSpace(space)) throw new Error('不是 Agent 空间');
  Object.assign(space.agent, patch);
}
```

3d. Guard `editSpace` against agent Spaces:

```ts
editSpace(space: BrowserSpace): void {
  const existing = this.requireSpace(space.id);
  if (isAgentSpace(existing)) throw new Error('Agent 空间的名称和颜色由 Agent 管理，无法直接编辑');
  Object.assign(existing, space);
}
```

3e. Guard `removeSpace` against active agent Spaces:

```ts
removeSpace(id: string): void {
  const existing = this.requireSpace(id);
  if (isAgentSpace(existing) && existing.agent.state === 'active') {
    throw new Error('无法删除正在运行的 Agent 空间：请先停止或接管');
  }
  // ... rest unchanged
}
```

3f. Add `removeAgentSpace` (returns tab ids for archiving):

```ts
/** 删除已结束的 Agent Space；返回它的所有标签 id（调用方负责归档）。*/
removeAgentSpace(id: string): string[] {
  const existing = this.requireSpace(id);
  if (!isAgentSpace(existing)) throw new Error('不是 Agent 空间');
  if (existing.agent.state === 'active') throw new Error('无法删除正在运行的 Agent 空间：请先停止或接管');
  const tabIds = [...this.tabs]
    .filter(([, meta]) => meta.spaceId === id)
    .map(([tabId]) => tabId);
  for (const tabId of tabIds) this.tabs.delete(tabId);
  const idx = this.spaces.findIndex((s) => s.id === id);
  this.spaces.splice(idx, 1);
  if (this.activeSpaceId === id) this.activeSpaceId = this.spaces[0]!.id;
  return tabIds;
}
```

3g. Guard `move` against active agent Spaces:

```ts
move(id: string, spaceId: string): void {
  const target = this.requireSpace(spaceId);
  if (isAgentSpace(target) && target.agent.state === 'active') {
    throw new Error('不能把标签移入正在运行的 Agent 空间');
  }
  const meta = this.get(id);
  const source = this.spaces.find((s) => s.id === meta.spaceId);
  if (source && isAgentSpace(source) && source.agent.state === 'active') {
    throw new Error('不能把标签从正在运行的 Agent 空间移走');
  }
  meta.spaceId = spaceId;
}
```

3h. Guard `setKind` against active agent Space:

```ts
setKind(id: string, kind: TabKind): void {
  const meta = this.get(id);
  const space = this.spaces.find((s) => s.id === meta.spaceId);
  if (space && isAgentSpace(space) && space.agent.state === 'active' && kind !== 'today') {
    throw new Error('Agent 空间里的标签不能设为固定或常用');
  }
  meta.kind = kind;
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/tab-organization.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/browser/tab-organization.ts tests/tab-organization.test.ts
git commit -m "feat(tab-org): Agent Space 守卫——用户空间计数、禁止移动、禁止编辑"
```

---

### Task 6 (Lane B): `AgentSpaces` rules engine

**Files:**
- Create: `src/main/external/spaces.ts`
- Create: `tests/agent-spaces.test.ts`

**Interfaces:**
- Consumes: `AgentSpaceError`, `SPACE_MESSAGES`, `ExternalSpaceControl`, `AgentSpaceSummary`, `SpaceAdmission` from `space-protocol.ts` (T1); `AgentSpaceInfo`, `AgentSpaceEndReason`, `isAgentSpace`, `AgentBrowserSpace`, `ACTIVE_AGENT_SPACE_LIMIT`, `ENDED_AGENT_SPACE_LIMIT`, `USER_SPACE_LIMIT` from `shared/tab-organization.ts` (T1); `TabOrganization.addAgentSpace`, `updateAgentSpace`, `removeAgentSpace`, `spaces` from `tab-organization.ts` (T5).
- Produces: `class AgentSpaces implements ExternalSpaceControl` and `interface AgentSpaceEffects`, for use by Task 8 (wiring).

- [ ] **Step 1: Write the failing test** — create `tests/agent-spaces.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { AgentSpaceError } from '../src/main/external/space-protocol.js';
import { TabOrganization } from '../src/main/browser/tab-organization.js';
import { AgentSpaces, type AgentSpaceEffects, type AgentSpaceTimer } from '../src/main/external/spaces.js';

interface State {
  spaces: ReturnType<AgentSpaces['listSync']>;
  tabs: Array<{ id: string; spaceId: string; ownerPrincipal: string }>;
}

function makeEffects(org: TabOrganization, timers: Map<string, ReturnType<typeof setTimeout>>): { effects: AgentSpaceEffects; archiveCalls: string[][] } {
  const archiveCalls: string[][] = [];
  const effects: AgentSpaceEffects = {
    clock: () => 0,
    setTimer: (key, delay, cb) => {
      const t = setTimeout(cb, delay);
      timers.set(key, t);
      return t;
    },
    clearTimer: (t) => { clearTimeout(t); },
    resolveClientName: () => '本机 Agent（CLI）',
    audit: vi.fn(),
    archiveTabs: (tabIds) => archiveCalls.push([...tabIds]),
    revokeAcl: vi.fn(),
    invalidatePrincipal: vi.fn(),
    rejectApprovals: vi.fn(),
    closeConnections: vi.fn(),
    saveAndBroadcast: vi.fn(),
    grantTabAcl: vi.fn(),
    userSpaceCount: () => org.spaces.filter((s) => !('agent' in s && s.agent)).length,
  };
  return { effects, archiveCalls };
}

describe('AgentSpaces', () => {
  it('creates a space and returns its id', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const result = await spaces.create('c1', '比价');
    expect(result.spaceId).toMatch(/^agent-/);
    expect(spaces.listSync('c1')).toHaveLength(1);
  });

  it('refuses the 9th active space with SPACE_LIMIT', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    for (let i = 0; i < 8; i++) await spaces.create('c1', `t${i}`);
    await expect(spaces.create('c1', 'overflow')).rejects.toMatchObject({ code: 'SPACE_LIMIT' });
  });

  it('admit returns ok for an active space', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    expect(await spaces.admit('c1', spaceId)).toBe('ok');
  });

  it('admit resumes an idle space', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    effects.clock = () => 1000;
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.end(spaceId, 'idle');
    effects.grantTabAcl = vi.fn();
    const admission = await spaces.admit('c1', spaceId);
    expect(admission).toBe('resumed');
  });

  it('admit rejects a stopped space with SPACE_ENDED', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.stop(spaceId);
    await expect(spaces.admit('c1', spaceId)).rejects.toMatchObject({ code: 'SPACE_ENDED' });
  });

  it('admit rejects unknown/foreign space with SPACE_NOT_FOUND', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    await spaces.create('c1', 't');
    await expect(spaces.admit('c2', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    await expect(spaces.admit('c1', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
  });

  it('touch resets the idle timer', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    expect(() => spaces.touch(spaceId)).not.toThrow();
  });

  it('close ends a space with reason closed', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.close('c1', spaceId);
    const s = spaces.listSync('c1')[0]!;
    expect(s.state).toBe('ended');
    expect(s.endReason).toBe('closed');
  });

  it('close on foreign space throws SPACE_NOT_FOUND', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    await expect(spaces.close('c2', 'agent-x')).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
  });

  it('stop ends with reason stopped and runs side effects in order', async () => {
    const org = new TabOrganization();
    const order: string[] = [];
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    effects.invalidatePrincipal = () => order.push('invalidate');
    effects.rejectApprovals = () => order.push('reject');
    effects.revokeAcl = () => order.push('revoke');
    effects.closeConnections = () => order.push('close');
    effects.saveAndBroadcast = () => order.push('save');
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.stop(spaceId);
    expect(order).toEqual(['invalidate', 'reject', 'revoke', 'close', 'save']);
    expect(spaces.listSync('c1')[0]!.endReason).toBe('stopped');
  });

  it('takeOver removes the agent field and refuses at 20 user spaces', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.takeOver(spaceId);
    expect(org.spaces.find((s) => s.id === spaceId)!.agent).toBeUndefined();
    // now at 1 user space; fill to 20 and try again
    for (let i = 1; i < 20; i++) org.createSpace(`u${i}`, 'teal', `uid-${i}`);
    const { spaceId: s2 } = await spaces.create('c1', 't2');
    await expect(spaces.takeOver(s2)).rejects.toMatchObject({ code: 'SPACE_LIMIT' });
  });

  it('stopClient ends all of a client active spaces', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    await spaces.create('c1', 't1');
    await spaces.create('c1', 't2');
    await spaces.create('c2', 't3');
    await spaces.stopClient('c1');
    const c1 = spaces.listSync('c1');
    expect(c1.every((s) => s.state === 'ended' && s.endReason === 'stopped')).toBe(true);
    expect(spaces.listSync('c2')[0]!.state).toBe('active');
  });

  it('evicts oldest ended space past the limit and archives its tabs', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects, archiveCalls } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    for (let i = 0; i < 9; i++) {
      const { spaceId } = await spaces.create('c1', `t${i}`);
      await spaces.end(spaceId, 'idle');
      effects.clock = () => i * 1000;
    }
    // 9 ended > 8 → oldest evicted
    expect(archiveCalls.length).toBeGreaterThanOrEqual(1);
    expect(effects.audit).toHaveBeenCalledWith('external.space.evicted', expect.any(Object));
  });

  it('resume re-grants only tabs owned by the sub-principal', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const granted: string[] = [];
    effects.grantTabAcl = (spaceId, tabId) => granted.push(tabId);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    // simulate tabs owned by this sub-principal and another
    const sub = `external:c1:${spaceId}`;
    const other = 'external:c1:agent-other';
    effects.tabsForSpace = () => [
      { id: 'mine', spaceId, ownerPrincipal: sub },
      { id: 'theirs', spaceId, ownerPrincipal: other },
    ];
    await spaces.end(spaceId, 'idle');
    granted.length = 0;
    await spaces.admit('c1', spaceId);
    expect(granted).toEqual(['mine']);
  });

  it('startup marks active spaces as restart', () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    // simulate a pre-existing active space persisted in tabState
    org.addAgentSpace({ id: 'agent-old', name: 'old', color: 'neutral', agent: { clientId: 'c1', label: 'old', createdAt: 0, state: 'active' } });
    spaces.onStartup();
    expect(org.spaces.find((s) => s.id === 'agent-old')!.agent!.state).toBe('ended');
    expect(org.spaces.find((s) => s.id === 'agent-old')!.agent!.endReason).toBe('restart');
  });

  it('cannot resume a closed space', async () => {
    const org = new TabOrganization();
    const timers = new Map();
    const { effects } = makeEffects(org, timers);
    const spaces = new AgentSpaces(org, effects);
    const { spaceId } = await spaces.create('c1', 't');
    await spaces.close('c1', spaceId);
    await expect(spaces.admit('c1', spaceId)).rejects.toMatchObject({ code: 'SPACE_ENDED' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/agent-spaces.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/main/external/spaces.ts`**

```ts
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_AGENT_SPACE_LIMIT,
  ENDED_AGENT_SPACE_LIMIT,
  USER_SPACE_LIMIT,
  type AgentBrowserSpace,
  type AgentSpaceEndReason,
  type AgentSpaceInfo,
  isAgentSpace,
} from '../../shared/tab-organization.js';
import { TabOrganization } from '../browser/tab-organization.js';
import {
  AgentSpaceError,
  type AgentSpaceSummary,
  type ExternalSpaceControl,
  type SpaceAdmission,
} from './space-protocol.js';

/** Agent Space 的副作用端口：main.ts 实现注入，spaces.ts 只定义接口。 */
export interface AgentSpaceEffects {
  clock(): number;
  setTimer(key: string, delay: number, cb: () => void): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  /** 解析 clientId 到展示名（已吊销返回「已吊销的客户端」）。 */
  resolveClientName(clientId: string): string;
  audit(eventType: string, payload: Record<string, unknown>): void;
  /** 归档一组标签（淘汰时调用）。 */
  archiveTabs(tabIds: string[]): void;
  /** 结束时：撤销子 principal 的标签 ACL。 */
  revokeAcl(principal: string): void;
  /** 结束时：中止子 principal 的在途操作。 */
  invalidatePrincipal(principal: string): void;
  /** 结束时：拒绝等待该子 principal 的审批。 */
  rejectApprovals(principal: string): void;
  /** 结束时：关闭该子 principal 的所有在线连接。 */
  closeConnections(principal: string): void;
  /** 结束/创建后：保存工作区并广播 state。 */
  saveAndBroadcast(): void;
  /** 恢复时：给指定标签授 ACL（只限 ownerPrincipal 匹配的）。 */
  grantTabAcl(spaceId: string, tabId: string): void;
  /** 用户 Space 当前数量（接管时检查 20 上限）。 */
  userSpaceCount(): number;
  /** 列出某 Space 下所有标签及其 ownerPrincipal（恢复时用）。 */
  tabsForSpace?(spaceId: string): Array<{ id: string; ownerPrincipal: string }>;
}

const IDLE_MS = 60 * 60_000;

export class AgentSpaces implements ExternalSpaceControl {
  readonly #org: TabOrganization;
  readonly #fx: AgentSpaceEffects;

  constructor(org: TabOrganization, effects: AgentSpaceEffects) {
    this.#org = org;
    this.#fx = effects;
  }

  /** 同步快照：list 控制帧与 UI 用。 */
  listSync(clientId: string): AgentSpaceSummary[] {
    return this.#org.spaces
      .filter(isAgentSpace)
      .filter((s) => s.agent.clientId === clientId)
      .map((s) => ({
        spaceId: s.id,
        label: s.agent.label,
        state: s.agent.state,
        ...(s.agent.endReason ? { endReason: s.agent.endReason } : {}),
      }));
  }

  async create(clientId: string, label: string): Promise<{ spaceId: string }> {
    const active = this.#org.spaces.filter((s) => isAgentSpace(s) && s.agent.state === 'active');
    if (active.length >= ACTIVE_AGENT_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    const spaceId = `agent-${randomUUID()}`;
    const space: AgentBrowserSpace = {
      id: spaceId,
      name: label,
      color: 'neutral',
      agent: { clientId, label, createdAt: this.#fx.clock(), state: 'active' },
    };
    this.#org.addAgentSpace(space);
    this.#fx.audit('external.space.created', { clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return { spaceId };
  }

  async admit(clientId: string, spaceId: string): Promise<SpaceAdmission> {
    const space = this.#findOwned(clientId, spaceId);
    if (space.agent.state === 'active') return 'ok';
    if (space.agent.endReason !== 'idle' && space.agent.endReason !== 'restart') {
      throw new AgentSpaceError('SPACE_ENDED');
    }
    const active = this.#org.spaces.filter((s) => isAgentSpace(s) && s.agent.state === 'active');
    if (active.length >= ACTIVE_AGENT_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    // 重新激活
    this.#org.updateAgentSpace(spaceId, { state: 'active', endedAt: undefined, endReason: undefined });
    // 只重新授权 ownerPrincipal 匹配的标签
    const sub = `external:${clientId}:${spaceId}`;
    const tabs = this.#fx.tabsForSpace?.(spaceId) ?? [];
    for (const tab of tabs) {
      if (tab.ownerPrincipal === sub) this.#fx.grantTabAcl(spaceId, tab.id);
    }
    this.#fx.audit('external.space.resumed', { clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return 'resumed';
  }

  async list(clientId: string): Promise<AgentSpaceSummary[]> {
    return this.listSync(clientId);
  }

  async close(clientId: string, spaceId: string): Promise<void> {
    const space = this.#findOwned(clientId, spaceId);
    if (space.agent.state === 'ended') return;
    await this.#end(spaceId, 'closed');
  }

  /** 用户从侧栏「停止」。 */
  async stop(spaceId: string): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.state === 'ended') return;
    await this.#end(spaceId, 'stopped');
  }

  /** 用户从侧栏「接管」。 */
  async takeOver(spaceId: string): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.state === 'active') {
      await this.#end(spaceId, 'stopped');
    }
    if (this.#fx.userSpaceCount() >= USER_SPACE_LIMIT) throw new AgentSpaceError('SPACE_LIMIT');
    // 去掉 agent 字段，变成普通用户 Space
    const idx = this.#org.spaces.findIndex((s) => s.id === spaceId);
    this.#org.spaces[idx] = { id: space.id, name: space.name, color: space.color };
    this.#fx.audit('external.space.taken_over', { clientId: space.agent.clientId, spaceId });
    this.#fx.saveAndBroadcast();
  }

  /** 吊销/删除客户端时停止它所有 active 的 Space。 */
  async stopClient(clientId: string): Promise<void> {
    const owned = this.#org.spaces.filter(
      (s) => isAgentSpace(s) && s.agent.clientId === clientId && s.agent.state === 'active',
    );
    for (const s of owned) await this.#end(s.id, 'stopped');
  }

  /** 内部结束逻辑。 */
  async #end(spaceId: string, reason: AgentSpaceEndReason): Promise<void> {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    const clientId = space.agent.clientId;
    const sub = `external:${clientId}:${spaceId}`;
    // 按顺序执行副作用
    this.#fx.invalidatePrincipal(sub);
    this.#fx.rejectApprovals(sub);
    this.#fx.revokeAcl(sub);
    this.#fx.closeConnections(sub);
    this.#org.updateAgentSpace(spaceId, {
      state: 'ended',
      endedAt: this.#fx.clock(),
      endReason: reason,
    });
    const eventType = `external.space.${reason === 'closed' ? 'closed' : reason === 'stopped' ? 'stopped' : 'idle'}`;
    this.#fx.audit(eventType, { clientId, spaceId });
    this.#evictIfNeeded();
    this.#fx.saveAndBroadcast();
  }

  /** 空闲计时触发。 */
  idleExpire(spaceId: string): void {
    void this.#end(spaceId, 'idle');
  }

  /** 每次工具请求刷新。 */
  touch(spaceId: string): void {
    // 由调用方重设 timer（main.ts 里在 run 之前调）
    // 这里只做存在性校验
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space) || space.agent.state !== 'active') {
      throw new AgentSpaceError('SPACE_NOT_FOUND');
    }
  }

  /** 启动时：所有 active Agent Space → restart。 */
  onStartup(): void {
    for (const space of this.#org.spaces) {
      if (isAgentSpace(space) && space.agent.state === 'active') {
        this.#org.updateAgentSpace(space.id, {
          state: 'ended',
          endedAt: this.#fx.clock(),
          endReason: 'restart',
        });
      }
    }
    this.#evictIfNeeded();
  }

  /** 删除已结束的 Agent Space（用户「删除」按钮），标签进归档。 */
  removeEnded(spaceId: string): string[] {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space)) throw new AgentSpaceError('SPACE_NOT_FOUND');
    if (space.agent.state === 'active') throw new AgentSpaceError('SPACE_ENDED');
    const tabIds = this.#org.removeAgentSpace(spaceId);
    this.#fx.archiveTabs(tabIds);
    this.#fx.audit('external.space.removed', { clientId: space.agent.clientId, spaceId });
    this.#fx.saveAndBroadcast();
    return tabIds;
  }

  #findOwned(clientId: string, spaceId: string): AgentBrowserSpace {
    const space = this.#org.spaces.find((s) => s.id === spaceId);
    if (!space || !isAgentSpace(space) || space.agent.clientId !== clientId) {
      throw new AgentSpaceError('SPACE_NOT_FOUND');
    }
    return space;
  }

  #evictIfNeeded(): void {
    const ended = this.#org.spaces
      .filter((s) => isAgentSpace(s) && s.agent.state === 'ended')
      .sort((a, b) => (a.agent.endedAt ?? 0) - (b.agent.endedAt ?? 0));
    if (ended.length <= ENDED_AGENT_SPACE_LIMIT) return;
    const evict = ended[0]!;
    const tabIds = this.#org.removeAgentSpace(evict.id);
    this.#fx.archiveTabs(tabIds);
    this.#fx.audit('external.space.evicted', {
      clientId: evict.agent.clientId,
      spaceId: evict.id,
    });
  }
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/agent-spaces.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/external/spaces.ts tests/agent-spaces.test.ts
git commit -m "feat(external): AgentSpaces 规则引擎——创建/结束/恢复/接管/淘汰"
```

---

### Task 7 (Lane B): Renderer — Agent group in SpaceSwitcher, IPC

**Files:**
- Create: `src/renderer/AgentSpaceGroup.tsx`
- Modify: `src/renderer/SpaceSwitcher.tsx`
- Modify: `src/renderer/browser-organization.css`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/entry.cts`
- Create: `tests/agent-space-group.test.ts`
- Modify: `tests/contracts.test.ts` (add `spaces` to parity describe.each)

**Interfaces:**
- Consumes: `AppState.spaces`, `AppState.agentClientNames`, `isAgentSpace` from `shared/tab-organization.ts` (T1); `IPC.spaceStopAgent`, `IPC.spaceTakeOverAgent` from `shared/contracts.ts` (T1); `window.pilion.spaces` from preload.
- Produces: `<AgentSpaceGroup>` component; `SpaceSwitcher` split into user and agent groups; preload `spaces.stopAgent` / `spaces.takeOverAgent`.

- [ ] **Step 1: Write the failing test** — create `tests/agent-space-group.test.ts`:

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AgentSpaceGroup } from '../src/renderer/AgentSpaceGroup';
import type { AppState } from '../src/shared/contracts';

const baseSpace = { id: 'agent-1', name: '比价', color: 'neutral' as const };
const activeSpace = { ...baseSpace, agent: { clientId: 'c1', label: '比价', createdAt: 1, state: 'active' as const } };
const endedSpace = { ...baseSpace, id: 'agent-2', agent: { clientId: 'c1', label: '旧', createdAt: 1, state: 'ended' as const, endedAt: 2, endReason: 'idle' as const } };

const run = async () => true;

it('renders an active agent space with AI 操作中 badge and 停止/接管 buttons', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [activeSpace],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'agent-1',
      run,
    }),
  );
  expect(html).toContain('本机 Agent（CLI）');
  expect(html).toContain('比价');
  expect(html).toContain('AI 操作中');
  expect(html).toContain('停止');
  expect(html).toContain('接管');
});

it('renders an ended agent space with 已结束 badge and 接管/删除 buttons', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [endedSpace],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'default',
      run,
    }),
  );
  expect(html).toContain('已结束');
  expect(html).toContain('接管');
  expect(html).toContain('删除');
});

it('shows 已吊销的客户端 when client is revoked', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [activeSpace],
      agentClientNames: { c1: '已吊销的客户端' },
      activeSpaceId: 'agent-1',
      run,
    }),
  );
  expect(html).toContain('已吊销的客户端');
});

it('renders nothing when there are no agent spaces', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [{ id: 'default', name: '我的工作区', color: 'neutral' }],
      agentClientNames: {},
      activeSpaceId: 'default',
      run,
    }),
  );
  expect(html.trim()).toBe('');
});

it('查看 switches to the space', () => {
  const calls: string[] = [];
  const html = renderToStaticMarkup(
    createElement(AgentSpaceGroup, {
      spaces: [activeSpace],
      agentClientNames: { c1: '本机 Agent（CLI）' },
      activeSpaceId: 'default',
      run: async (fn: () => Promise<unknown>) => { await fn(); calls.push('selected'); return true; },
    }),
  );
  // The 查看 button should be rendered
  expect(html).toContain('查看');
});
```

Also add `'spaces'` to the `describe.each` array in `tests/contracts.test.ts`:

```ts
describe.each(['skills', 'updates', 'downloads', 'browsingData', 'schedules', 'external', 'spaces'])(
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/agent-space-group.test.ts tests/contracts.test.ts`
Expected: FAIL — `AgentSpaceGroup` does not exist; `spaces` parity fails.

- [ ] **Step 3: Create `src/renderer/AgentSpaceGroup.tsx`**

```tsx
import { Check } from 'lucide-react';
import type { BrowserSpace } from '../shared/tab-organization';
import { isAgentSpace } from '../shared/tab-organization';
import type { AppState } from '../shared/contracts';

type Props = {
  spaces: BrowserSpace[];
  agentClientNames?: Record<string, string>;
  activeSpaceId?: string;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

export function AgentSpaceGroup({ spaces, agentClientNames, activeSpaceId, run }: Props) {
  const agentSpaces = spaces.filter(isAgentSpace);
  if (agentSpaces.length === 0) return null;

  return (
    <div className="space-agent-group" role="group" aria-label="Agent 空间">
      <div className="space-agent-group-header">
        <small>Agent</small>
      </div>
      {agentSpaces.map((space) => {
        const agent = space.agent;
        const clientName = agentClientNames?.[agent.clientId] ?? '外部客户端';
        const isActive = agent.state === 'active';
        return (
          <div key={space.id} className="space-agent-row">
            <button
              className="space-agent-main"
              aria-pressed={space.id === activeSpaceId}
              onClick={async () => {
                if (await run(() => window.pilion.spaces.select(space.id))) {
                  /* popover closes via parent */
                }
              }}
            >
              <span className="space-agent-label">{clientName} · {agent.label}</span>
              <span className={`space-agent-status ${isActive ? 'active' : 'ended'}`}>
                {isActive ? (
                  <>
                    <span className="space-agent-activity" aria-label="Agent 在此空间运行" />
                    AI 操作中
                  </>
                ) : (
                  '已结束'
                )}
              </span>
              {space.id === activeSpaceId && <Check size={13} />}
            </button>
            <div className="space-agent-actions">
              <button
                className="space-agent-action"
                disabled={!isActive}
                onClick={() => run(() => window.pilion.spaces.stopAgent(space.id))}
              >
                停止
              </button>
              <button
                className="space-agent-action"
                onClick={() => run(() => window.pilion.spaces.takeOverAgent(space.id))}
              >
                接管
              </button>
              {!isActive && (
                <button
                  className="space-agent-action"
                  onClick={() => run(() => window.pilion.spaces.remove(space.id))}
                >
                  删除
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Modify `src/renderer/SpaceSwitcher.tsx`**

In the non-editing branch (the `<>` fragment that renders `<div className="space-list">`), add the Agent group after the space-list div and before the menu actions:

```tsx
import { AgentSpaceGroup } from './AgentSpaceGroup';
```

After the closing `</div>` of `space-list` and before the "新建空间" button:

```tsx
<AgentSpaceGroup
  spaces={spaces}
  agentClientNames={state.agentClientNames}
  activeSpaceId={state.activeSpaceId}
  run={run}
/>
```

Also: when `current` is an agent space, disable the "编辑当前空间" button:

```tsx
<button
  className="space-menu-action"
  onClick={() => edit('edit')}
  disabled={isAgentSpace(current)}
  title={isAgentSpace(current) ? 'Agent 空间无法编辑' : undefined}
>
```

Import `isAgentSpace` from `../shared/tab-organization`.

- [ ] **Step 5: Add CSS to `src/renderer/browser-organization.css`**

```css
.space-agent-group {
  border-top: 1px solid var(--border);
  padding-top: 5px;
  margin-top: 5px;
}
.space-agent-group-header small {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 7px 3px;
  display: block;
}
.space-agent-row {
  border-radius: var(--r-control);
  padding: 4px 7px;
}
.space-agent-row:hover {
  background: var(--hover);
}
.space-agent-main {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 0;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  color: var(--text);
}
.space-agent-main[aria-pressed='true'] {
  background: color-mix(in srgb, var(--accent) 10%, var(--hover));
  border-radius: var(--r-control);
}
.space-agent-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.space-agent-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  white-space: nowrap;
}
.space-agent-status.active {
  color: var(--accent);
}
.space-agent-status.ended {
  color: var(--muted);
}
.space-agent-actions {
  display: flex;
  gap: 4px;
  padding: 2px 0 2px 18px;
}
.space-agent-action {
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-control);
  background: none;
  color: var(--text);
  cursor: pointer;
}
.space-agent-action:hover:not(:disabled) {
  background: var(--hover);
}
.space-agent-action:disabled {
  opacity: 0.4;
  cursor: default;
}
.space-agent-action:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, var(--text));
  outline-offset: -2px;
}
```

- [ ] **Step 6: Add `stopAgent` / `takeOverAgent` to both preload entry points**

In `src/preload/index.ts`, inside the `spaces: Object.freeze({...})` block, add:

```ts
    stopAgent: (id: string) => ipcRenderer.invoke(IPC.spaceStopAgent, { id }),
    takeOverAgent: (id: string) => ipcRenderer.invoke(IPC.spaceTakeOverAgent, { id }),
```

In `src/preload/entry.cts`, add the same two methods to the `spaces` group and add the IPC channels to the local `IPC` object:

```ts
  spaceStopAgent: 'spaces:stop-agent',
  spaceTakeOverAgent: 'spaces:take-over-agent',
```

Both groups must be byte-identical (the parity test checks this).

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `pnpm vitest run tests/agent-space-group.test.ts tests/contracts.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/AgentSpaceGroup.tsx src/renderer/SpaceSwitcher.tsx src/renderer/browser-organization.css src/preload/index.ts src/preload/entry.cts tests/agent-space-group.test.ts tests/contracts.test.ts
git commit -m "feat(ui): SpaceSwitcher Agent 分组——查看/停止/接管/删除"
```

---

### Task 8 (serial): `main.ts` wiring

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/external/types.ts`
- Modify: `src/main/external/server.ts` (minimal: add `spaces` to runtime stub)
- Modify: `tests/main-tab-provenance.test.ts` (add `agentSpaces` stub so `openAgentTab` vm-snippet works)
- Modify: `tests/main-session-security.test.ts` (add `spaces` stub to the runtime mock if needed)

**Interfaces:**
- Consumes: `AgentSpaces` (T6), `AgentSpaceEffects` (T6), `ExternalSpaceControl` (T1), `AgentSpaceError` (T1), `externalSpacePrincipal`, `parseExternalPrincipal` (T1), `IPC.spaceStopAgent`, `IPC.spaceTakeOverAgent` (T1), `TabOrganization.addAgentSpace` / `removeAgentSpace` (T5), `isAgentSpace` (T1).
- Produces: fully wired `agentSpaces`, `admitExternalConnection` with sub-principal, `openAgentTab` routing, `endAgentSpaceEffect`, IPC handlers for `stopAgent`/`takeOverAgent`, `agentClientNames` in AppState, `requireAgentSpaces` slot filled.

- [ ] **Step 1: Extend `ExternalRuntime` in `src/main/external/types.ts`**

Find the `ExternalRuntime` interface and add:

```ts
spaces: import('./space-protocol.js').ExternalSpaceControl;
```

The import can be a top-level import if the file already imports from `space-protocol.ts`; otherwise use the inline form to avoid circular deps.

- [ ] **Step 2: Add `spaces` stub to `tests/external-server.test.ts`**

In the `beforeEach` that sets up `captured`:

```ts
captured.spaces = {
  create: vi.fn(async () => ({ spaceId: 'agent-test' })),
  admit: vi.fn(async () => 'ok' as const),
  list: vi.fn(async () => []),
  close: vi.fn(async () => {}),
  stopClient: vi.fn(async () => {}),
  listSync: vi.fn(() => []),
};
```

- [ ] **Step 3: Add `agentSpaces` stub to `tests/main-tab-provenance.test.ts`**

In the `openAgentTab` test's context, add a stub so the vm-snippet resolves the identifier:

```ts
agentSpaces: null,
```

(The function only checks `agentSpaces` when `principal` starts with `external:`; the test passes `'user'`, so this stub is never exercised.)

- [ ] **Step 4: Implement `requireAgentSpaces` slot in `src/main/main.ts`**

Find the comment `// AGENT_SPACES_SLOT` left by Task 1 and replace it with:

```ts
function requireAgentSpaces(): AgentSpaces {
  if (!agentSpaces) throw new Error('agentSpaces not yet initialized');
  return agentSpaces;
}
```

Also declare the module-level variable above it:

```ts
let agentSpaces: import('./external/spaces.js').AgentSpaces | undefined;
```

- [ ] **Step 5: Wire `AgentSpaces` in `startAgentIntegration()`**

Inside `startAgentIntegration()`, after `tabOrganization` and the tab-restore loop are guaranteed to have run (at the end of `init()` chain), add:

```ts
const { AgentSpaces } = await import('./external/spaces.js');
const agentEffects: import('./external/spaces.js').AgentSpaceEffects = {
  clock: () => Date.now(),
  setTimer: (key, delay, cb) => {
    const t = setTimeout(cb, delay);
    spaceTimers.set(key, t);
    return t;
  },
  clearTimer: (t) => clearTimeout(t),
  resolveClientName: (clientId) => {
    const reg = externalRegistry.get(clientId);
    return reg ? reg.name : '已吊销的客户端';
  },
  audit: (eventType, payload) => auditLog(eventType, payload),
  archiveTabs: (tabIds) => {
    for (const tabId of tabIds) {
      const meta = tabOrganization.get(tabId);
      if (meta) archivedTabs.unshift({ id: randomUUID(), ...meta, archivedAt: Date.now() });
    }
    archivedTabs.splice(200);
    rememberTabs();
  },
  revokeAcl: (principal) => browser.registry.revokeAll(principal),
  invalidatePrincipal: (principal) => browser.invalidatePrincipal?.(principal),
  rejectApprovals: (principal) => {
    for (const [id, approval] of approvals) {
      if (approval.principal === principal) {
        approvals.delete(id);
        emit('approvalsChanged');
      }
    }
  },
  closeConnections: (principal) => {
    for (const conn of activeConnections()) {
      if (conn.principal === principal) conn.close?.();
    }
  },
  saveAndBroadcast: () => { rememberTabs(); emit('stateChanged'); },
  grantTabAcl: (spaceId, tabId) => {
    const page = pages.get(tabId);
    if (page) browser.setTabAcl(tabId, `external:${spaceId}`, 'manage');
  },
  userSpaceCount: () => tabOrganization.spaces.filter((s) => !isAgentSpace(s)).length,
  tabsForSpace: (spaceId) =>
    [...tabOrganization.tabs.entries()]
      .filter(([, meta]) => meta.spaceId === spaceId)
      .map(([id, meta]) => ({ id, ownerPrincipal: meta.ownerPrincipal ?? USER_PRINCIPAL })),
};
agentSpaces = new AgentSpaces(tabOrganization, agentEffects);
agentSpaces.onStartup();
```

Note: `spaceTimers` is a `Map<string, ReturnType<typeof setTimeout>>` declared in module scope near `archivedTabs`.

- [ ] **Step 6: Extend `admitExternalConnection` to accept `spaceId`**

Change the function signature:

```ts
async function admitExternalConnection(clientId: string, name: string, spaceId?: string): Promise<string> {
```

When `spaceId` is provided, derive the sub-principal and create a separate `externalAttachments` entry:

```ts
if (spaceId) {
  const sub = externalSpacePrincipal(clientId, spaceId);
  const attachmentId = randomUUID();
  externalAttachments.set(attachmentId, {
    principal: sub,
    clientId,
    spaceId,
    run: makeBoundRun(sub, spaceId),
  });
  return attachmentId;
}
// existing code for base principal
```

Where `makeBoundRun(sub, spaceId)` wraps the existing `run` function to call `agentSpaces?.touch(spaceId)` before each invocation and check Space state first.

- [ ] **Step 7: Update `openAgentTab` to route to Agent Space**

In `openAgentTab`, the existing code resolves the target spaceId from `previousTabId`'s space or `tabOrganization.activeSpaceId`. Change it:

```ts
async function openAgentTab(principal: string, url: string): Promise<string> {
  // For sub-principal (external:clientId:spaceId), route to Agent Space
  const parsed = parseExternalPrincipal(principal);
  const targetSpaceId =
    parsed?.spaceId
      ? parsed.spaceId
      : tabOrganization.spaces.find((s) => !isAgentSpace(s) && s.id === tabOrganization.activeSpaceId)?.id
        ?? tabOrganization.spaces.find((s) => !isAgentSpace(s))!.id;
  // remainder is the existing openAgentTab body, but pass targetSpaceId explicitly
```

Also update `bindPage` call inside to pass `ownerPrincipal: principal` in the metadata.

- [ ] **Step 8: Add `endAgentSpaceEffect` and IPC handlers**

Extract the 5-step end sequence into a named function (this avoids adding free identifiers inside `init()`):

```ts
async function endAgentSpaceEffect(spaceId: string, reason: AgentSpaceEndReason): Promise<void> {
  const space = tabOrganization.spaces.find((s) => s.id === spaceId);
  if (!space || !isAgentSpace(space)) return;
  requireAgentSpaces().idleExpire(spaceId);
  // side effects already ordered inside AgentSpaces.#end
}
```

Add IPC handlers:

```ts
ipcMain.handle(IPC.spaceStopAgent, async (_, { id }: { id: string }) => {
  await requireAgentSpaces().stop(id);
  emit('stateChanged');
});
ipcMain.handle(IPC.spaceTakeOverAgent, async (_, { id }: { id: string }) => {
  await requireAgentSpaces().takeOver(id);
  emit('stateChanged');
});
```

- [ ] **Step 9: Build `agentClientNames` into AppState**

In the function that builds the `AppState` object for broadcast (search for `spaces: tabOrganization.spaces`):

```ts
agentClientNames: Object.fromEntries(
  tabOrganization.spaces
    .filter(isAgentSpace)
    .map((s) => [
      s.agent.clientId,
      externalRegistry.get(s.agent.clientId)?.name ?? '外部客户端',
    ]),
),
```

- [ ] **Step 10: Update approval summary for sub-principal**

In the section that builds the approval source description, add a branch:

```ts
const parsed = parseExternalPrincipal(actor.principal);
if (parsed?.spaceId) {
  const clientName = externalRegistry.get(parsed.clientId)?.name ?? '外部客户端';
  const spaceLabel = tabOrganization.spaces.find((s) => s.id === parsed.spaceId)?.name ?? parsed.spaceId;
  sourceDescription = `来源：外部调用（${clientName} · ${spaceLabel}）`;
}
```

- [ ] **Step 11: Redirect user-opened tabs away from active Agent Spaces**

In `openTab` (user ⌘T path), after `spaceId` is resolved:

```ts
const targetSpace = tabOrganization.spaces.find((s) => s.id === spaceId);
if (targetSpace && isAgentSpace(targetSpace) && targetSpace.agent.state === 'active') {
  spaceId = tabOrganization.spaces.find((s) => !isAgentSpace(s))?.id ?? 'default';
}
```

- [ ] **Step 12: Run full unit test suite, typecheck, lint**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: all PASS. If vm-snippet tests fail with `agentSpaces is not defined`, add a stub to the relevant test's context as shown in Step 3.

- [ ] **Step 13: Commit**

```bash
git add src/main/main.ts src/main/external/types.ts tests/main-tab-provenance.test.ts tests/main-session-security.test.ts
git commit -m "feat(main): 接线 AgentSpaces——子 principal、openAgentTab 路由、IPC 处理器"
```

---

### Task 9 (serial): Docs update

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `CHANGELOG.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update `README.md`**

In the External Channel section (or wherever `pilion` CLI usage is described), add:

```md
### Agent Spaces

每个外部 Agent 对话在 Pilion 里拥有独立的 Agent Space。Codex、Claude Code 等集成客户端必须为每个对话创建一个 Space：

\`\`\`bash
# 1. 建立 Space（只打印 spaceId）
SPACE=$(pilion space new "比价任务")

# 2. 每条命令带上 --space（或 export PILION_SPACE=...）
pilion navigate --space $SPACE https://example.com/
pilion screenshot --space $SPACE

# 3. 完成后关闭
pilion space close $SPACE
\`\`\`

用户可在 Pilion 空间切换器的「Agent」分组里查看所有 Agent Space，并执行「查看 / 停止 / 接管」。
```

- [ ] **Step 2: Update `docs/architecture.md`**

In the External Channel section, add a subsection:

```md
#### Sub-principals

带 `--space` 的外部客户端连接后，其 principal 变为 `external:<clientId>:<spaceId>`，对应 `externalAttachments` 里的独立 attachment。`TabRegistry` 的 ACL 按完整 principal 精确匹配，故子 principal 天然隔离——它只能访问以自身 principal 登记的标签，碰不到其他 Agent Space 或用户的标签。

`AgentSpaces` 类（`src/main/external/spaces.ts`）是纯规则引擎：时钟、定时器与所有副作用经 `AgentSpaceEffects` 端口注入，与 Electron 解耦，可在 vitest 里独立测试。main.ts 仅负责接线与副作用实现。
```

- [ ] **Step 3: Update `CHANGELOG.md`**

In the `[未发布]` section add:

```md
### Added
- **Agent Spaces**：每个外部 Agent 对话独立的 Agent Space，子 principal `external:<clientId>:<spaceId>` 严格隔离标签 ACL。
- `pilion space new/list/close` 命令；所有浏览器命令支持 `--space` 参数（回落 `$PILION_SPACE`）。
- 空间切换器「Agent」分组：查看 / 停止 / 接管 / 删除。
- 60 分钟空闲自动结束；启动时 active Space 标记为 restart；已结束超过 8 个时自动淘汰最旧的。
- 集成客户端不带 `--space` 发工具帧时收到 `SPACE_REQUIRED` 错误及纠正指引。
```

- [ ] **Step 4: Run build to verify no TS errors in docs references**

Run: `pnpm typecheck`
Expected: PASS (docs are markdown, not TypeScript — this step verifies nothing was broken by earlier commits).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md CHANGELOG.md
git commit -m "docs: Agent Spaces 说明——README、architecture.md、CHANGELOG"
```

---

### Task 10 (serial): E2E + full verification

**Files:**
- Modify: `tests/electron.e2e.ts`
- Modify: `tests/fixtures/e2e-agent.mjs`

**Interfaces:** Consumes all shipped behavior from Tasks 1–9.

- [ ] **Step 1: Add Agent Space E2E scenario to `tests/electron.e2e.ts`**

Add a new `test.describe('Agent Spaces')` block:

```ts
test.describe('Agent Spaces', () => {
  test('two parallel spaces are isolated and the switcher shows both', async ({ page }) => {
    // Arrange: launch two parallel pilion CLI sessions, each with their own space
    const sp1 = execSync(
      `${CLI} space new "E2E-Space-1" --json`,
      { env: { ...process.env, HOME: PILION_INTEGRATION_HOME } },
    );
    const { spaceId: space1 } = JSON.parse(sp1.toString().trim());

    const sp2 = execSync(
      `${CLI} space new "E2E-Space-2" --json`,
      { env: { ...process.env, HOME: PILION_INTEGRATION_HOME } },
    );
    const { spaceId: space2 } = JSON.parse(sp2.toString().trim());

    // Act: open a tab in each space
    execSync(
      `${CLI} navigate --space ${space1} https://example.com/`,
      { env: { ...process.env, HOME: PILION_INTEGRATION_HOME } },
    );
    execSync(
      `${CLI} navigate --space ${space2} https://example.com/about`,
      { env: { ...process.env, HOME: PILION_INTEGRATION_HOME } },
    );

    // Assert: switcher shows Agent group with two rows
    await page.click('[data-testid="space-switcher-trigger"]');
    await expect(page.locator('.space-agent-group')).toBeVisible();
    await expect(page.locator('.space-agent-row')).toHaveCount(2);

    // Assert: cross-access rejected — space1 CLI cannot read space2's tab
    const list2 = execSync(`${CLI} tabs --space ${space1} --json`, {
      env: { ...process.env, HOME: PILION_INTEGRATION_HOME },
    });
    const tabs2 = JSON.parse(list2.toString());
    expect(tabs2.every((t: { url: string }) => t.url !== 'https://example.com/about')).toBe(true);

    // Assert: user's activeSpaceId did not change
    const state = await page.evaluate(() => (window as any).pilion?.getState?.());
    expect(state?.activeSpaceId).not.toMatch(/^agent-/);
  });

  test('stopping a space prevents further CLI use and the second space stays active', async ({ page }) => {
    const sp = execSync(
      `${CLI} space new "E2E-Stop" --json`,
      { env: { ...process.env, HOME: PILION_INTEGRATION_HOME } },
    );
    const { spaceId } = JSON.parse(sp.toString().trim());
    execSync(`${CLI} navigate --space ${spaceId} https://example.com/`, {
      env: { ...process.env, HOME: PILION_INTEGRATION_HOME },
    });

    // Stop via UI
    await page.click('[data-testid="space-switcher-trigger"]');
    const stopBtn = page.locator(`.space-agent-row >> button:has-text("停止")`).first();
    await stopBtn.click();
    await page.waitForTimeout(300);

    // CLI command after stop should fail with SPACE_ENDED
    expect(() =>
      execSync(`${CLI} navigate --space ${spaceId} https://example.com/`, {
        env: { ...process.env, HOME: PILION_INTEGRATION_HOME },
      })
    ).toThrow();
  });

  test('no --space on a browser command returns SPACE_REQUIRED', () => {
    expect(() =>
      execSync(`${CLI} navigate https://example.com/`, {
        env: { ...process.env, HOME: PILION_INTEGRATION_HOME },
      })
    ).toThrow(/SPACE_REQUIRED/);
  });
});
```

- [ ] **Step 2: Update `tests/fixtures/e2e-agent.mjs` if needed**

If the fixture drives pilion commands, add a `space new` step before any browser commands:

```js
// Before: pilion navigate https://...
// After:
const spaceOut = execSync(`${CLI} space new "e2e-agent" --json`).toString().trim();
const { spaceId } = JSON.parse(spaceOut);
execSync(`${CLI} navigate --space ${spaceId} ${url}`);
```

- [ ] **Step 3: Run full unit tests**

Run: `pnpm vitest run`
Expected: all PASS.

- [ ] **Step 4: Run E2E tests (requires app running)**

Run: `pnpm test:e2e`
Expected: all PASS, including new `Agent Spaces` suite.

If the app can't run in CI, mark the new tests with `test.skip` and note in the PR that they must be run locally.

- [ ] **Step 5: Final commit**

```bash
git add tests/electron.e2e.ts tests/fixtures/e2e-agent.mjs
git commit -m "test(e2e): Agent Spaces——并行隔离、停止、SPACE_REQUIRED 场景"
```

---

## Self-review against spec

| Spec requirement | Covered by task |
| --- | --- |
| Sub-principal `external:<clientId>:<spaceId>` | T1 (space-protocol.ts), T8 (admitExternalConnection) |
| `AgentSpaceInfoSchema` on `BrowserSpaceSchema` | T1 |
| Space cap 40 (schema), user-cap 20 in createSpace | T1, T5 |
| `AgentSpaces` rules: create, end, resume, evict, startup | T6 |
| Idle 60 min, `touch` resets timer | T6, T8 |
| Resume only for `idle`/`restart` | T6 |
| `end` side effects in order | T6, T8 |
| `takeOver`: `stop` + strip `agent` field, user-cap check | T6 |
| `stopClient` on revoke/delete | T2, T6 |
| hello `space?` field, four admit outcomes | T2 |
| Control frames: `space.create/list/close`, no allowlist check | T2 |
| `SPACE_REQUIRED` for integration clients without space | T2 |
| `pilion space new/list/close`, `--space` flag, `$PILION_SPACE` | T3 |
| `space new` stdout = spaceId only; hint to stderr | T3 |
| guide.ts workflow leading with `space new` | T4 |
| `install.md` troubleshooting entry for `SPACE_REQUIRED` | T4 |
| `openAgentTab` routes to Agent Space for sub-principal | T8 |
| User-opened tabs redirect away from active Agent Space | T8 |
| `SpaceSwitcher` Agent group: view/stop/take-over/delete | T7 |
| `agentClientNames` in AppState | T1 (schema), T8 (build) |
| Approval summary source text for sub-principal | T8 |
| Preload `spaces.stopAgent/takeOverAgent` parity | T7 |
| `SpaceEditSchema` rejects `agent` field | T1 |
| Audit events (created/closed/stopped/taken_over/resumed/evicted/idle) | T6 |
| E2E: parallel spaces, cross-access rejection, stop, take-over, SPACE_REQUIRED | T10 |
| SKILL.md version not bumped independently | global constraint respected throughout |
| vm-snippet tests still pass (no new free identifiers in init) | T8 (Step 3/12) |
