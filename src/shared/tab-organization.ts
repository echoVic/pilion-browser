import { z } from 'zod';

export const SPACE_COLORS = ['neutral', 'teal', 'blue', 'purple', 'rose', 'amber'] as const;
export const TabKindSchema = z.enum(['today', 'pinned', 'favorite']);
export type TabKind = z.infer<typeof TabKindSchema>;
export const SpaceColorSchema = z.enum(SPACE_COLORS);
export type SpaceColor = z.infer<typeof SpaceColorSchema>;
export const USER_SPACE_LIMIT = 20;
export const ACTIVE_AGENT_SPACE_LIMIT = 8;
export const ENDED_AGENT_SPACE_LIMIT = 8;
export const AGENT_SPACE_IDLE_MS = 3600000;
export const AGENT_SPACE_END_REASONS = ['closed', 'stopped', 'idle', 'restart', 'handed_back'] as const;
export type AgentSpaceEndReason = (typeof AGENT_SPACE_END_REASONS)[number];
/** 外部 Agent 对话专属空间的元数据；只由主进程写，渲染进程的 create/edit schema 不含它。 */
export const AgentSpaceInfoSchema = z.object({
  clientId: z.string().min(1).max(256),
  label: z.string().trim().min(1).max(40),
  createdAt: z.number().finite().nonnegative(),
  state: z.enum(['active', 'ended']),
  endedAt: z.number().finite().nonnegative().optional(),
  endReason: z.enum(AGENT_SPACE_END_REASONS).optional(),
  /** 被用户临时接管的时间。有值 ⇒ 空间在人手里、可交还；永久接管会直接删掉 agent 字段。 */
  takenOverAt: z.number().finite().nonnegative().optional(),
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
/** 临时接管中的 Agent Space：身份与标签来源都还在，用户可以交还。 */
export function isTakenOver(space: BrowserSpace): boolean {
  return isAgentSpace(space) && space.agent.takenOverAt !== undefined;
}
/**
 * 人手里的空间计数：普通用户空间 + 临时接管的 Agent 空间。
 * 两者共用同一个容量预算，否则接管态会绕过上限把 spaces 数组撑破 schema。
 */
export function userCustodyCount(spaces: ReadonlyArray<BrowserSpace>): number {
  return spaces.filter((space) => !isAgentSpace(space) || space.agent.takenOverAt !== undefined)
    .length;
}
export const TabMetadataSchema = z.object({
  spaceId: z.string().min(1).max(256),
  kind: TabKindSchema,
  lastActiveAt: z.number().finite().nonnegative(),
});
export type TabMetadata = z.infer<typeof TabMetadataSchema>;
export const SavedBrowserTabSchema = TabMetadataSchema.extend({
  title: z.string().max(4096),
  // Trusted lifecycle provenance; absent in legacy human-owned records.
  ownerPrincipal: z.string().min(1).max(4096).optional(),
  // 编码后的中文查询可能比 IPC 原始输入长数倍，持久化不截断网址。
  url: z.string().min(1),
});
export type SavedBrowserTab = z.infer<typeof SavedBrowserTabSchema>;
export const ArchivedTabSchema = SavedBrowserTabSchema.extend({
  id: z.string().min(1).max(256),
  archivedAt: z.number().finite().nonnegative(),
});
export type ArchivedTab = z.infer<typeof ArchivedTabSchema>;
export const TabStateSchema = z.object({
  spaces: z.array(BrowserSpaceSchema).min(1).max(40),
  activeSpaceId: z.string().min(1).max(256),
  tabs: z.array(SavedBrowserTabSchema),
  archivedTabs: z.array(ArchivedTabSchema).max(200),
});
export const SpaceCreateSchema = SpaceFieldsSchema.omit({ id: true }).strict();
export const SpaceEditSchema = SpaceFieldsSchema.strict();
export const TabKindInputSchema = z
  .object({ id: z.string().min(1).max(256), kind: TabKindSchema })
  .strict();
export const TabMoveInputSchema = z
  .object({ id: z.string().min(1).max(256), spaceId: z.string().min(1).max(256) })
  .strict();
export const DEFAULT_SPACE: BrowserSpace = { id: 'default', name: '我的工作区', color: 'neutral' };
