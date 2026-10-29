import { z } from 'zod';

export const SPACE_COLORS = ['neutral', 'teal', 'blue', 'purple', 'rose', 'amber'] as const;
export const TabKindSchema = z.enum(['today', 'pinned', 'favorite']);
export type TabKind = z.infer<typeof TabKindSchema>;
export const SpaceColorSchema = z.enum(SPACE_COLORS);
export type SpaceColor = z.infer<typeof SpaceColorSchema>;
export const BrowserSpaceSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(40),
  color: SpaceColorSchema,
});
export type BrowserSpace = z.infer<typeof BrowserSpaceSchema>;
export const TabMetadataSchema = z.object({
  spaceId: z.string().min(1).max(256),
  kind: TabKindSchema,
  lastActiveAt: z.number().finite().nonnegative(),
});
export type TabMetadata = z.infer<typeof TabMetadataSchema>;
export const SavedBrowserTabSchema = TabMetadataSchema.extend({
  title: z.string().max(4096),
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
  spaces: z.array(BrowserSpaceSchema).min(1).max(20),
  activeSpaceId: z.string().min(1).max(256),
  tabs: z.array(SavedBrowserTabSchema),
  archivedTabs: z.array(ArchivedTabSchema).max(200),
});
export const SpaceCreateSchema = BrowserSpaceSchema.omit({ id: true }).strict();
export const SpaceEditSchema = BrowserSpaceSchema.strict();
export const TabKindInputSchema = z
  .object({ id: z.string().min(1).max(256), kind: TabKindSchema })
  .strict();
export const TabMoveInputSchema = z
  .object({ id: z.string().min(1).max(256), spaceId: z.string().min(1).max(256) })
  .strict();
export const DEFAULT_SPACE: BrowserSpace = { id: 'default', name: '我的工作区', color: 'neutral' };
