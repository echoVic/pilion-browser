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

export type AgentSpaceErrorCode =
  | 'SPACE_NOT_FOUND'
  | 'SPACE_ENDED'
  | 'SPACE_TAKEN_OVER'
  | 'SPACE_NOT_HAND_BACKABLE'
  | 'SPACE_CLIENT_REVOKED'
  | 'SPACE_LIMIT'
  | 'SPACE_REQUIRED';

export const SPACE_MESSAGES: Record<AgentSpaceErrorCode, string> = {
  SPACE_NOT_FOUND: 'Space 不存在或不属于本客户端',
  SPACE_ENDED: 'Space 已结束，请用 pilion space new 新建',
  SPACE_TAKEN_OVER:
    '该 Space 已被用户接管：等用户在 Pilion 侧栏点「交还」后再试，不要新建或切换 Space',
  SPACE_NOT_HAND_BACKABLE: '这个 Space 当前不处于可交还状态',
  SPACE_CLIENT_REVOKED: '该客户端已被吊销，交还后也无法连接；请改为「转为我自己的空间」或删除',
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
  /** agent：Agent 持有；user：被用户临时接管，等下交还。 */
  custody: 'agent' | 'user';
  /** 只有用户能交还；custody=agent 时恒为 false。 */
  handBackable: boolean;
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
