import { z } from 'zod';
import { SEARCH_ENGINE_IDS } from './search-engines.js';

const fields = {
  theme: z.enum(['light', 'dark', 'auto']),
  startupBehavior: z.enum(['restore', 'new']),
  searchEngine: z.enum(SEARCH_ENGINE_IDS),
  quitOnWindowClose: z.boolean(),
  agentWindowBehavior: z.enum(['foreground', 'silent']),
  autoUpdate: z.boolean(),
};

/**
 * 全局设置，存在 userData/settings.json，与每个工作区自己的 workspace.json 分开。
 * 文件里某一项被改坏只回退那一项；未知的键读入时丢掉。
 */
export const AppSettingsSchema = z.object({
  /** 缺省表示渲染层还没把旧版存在 localStorage 里的主题迁过来。 */
  theme: fields.theme.optional().catch(undefined),
  startupBehavior: fields.startupBehavior.default('restore').catch('restore'),
  searchEngine: fields.searchEngine.default('google').catch('google'),
  quitOnWindowClose: fields.quitOnWindowClose.default(true).catch(true),
  agentWindowBehavior: fields.agentWindowBehavior.default('foreground').catch('foreground'),
  /** 只管自动检查和下载；已经下好的更新，退出时总会安装。 */
  autoUpdate: fields.autoUpdate.default(true).catch(true),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type Theme = z.infer<typeof fields.theme>;

/** 渲染层只送改动的那几项；没有默认值，免得一次局部保存把其余项重置。 */
export const AppSettingsPatchSchema = z.object(fields).partial().strict();
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;
