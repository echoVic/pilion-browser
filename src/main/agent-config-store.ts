import { randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AgentConfigSchema, type AgentConfig } from '../shared/contracts.js';

/**
 * userData/agents.json：人配置好的 Agent 连接（命令、参数、环境变量、SSH 主机）。
 *
 * 读：逐条校验。一条读不懂（旧版本写下的、新版本才有的字段、手改坏的）只跳过它自己——
 * 整份按「全有或全无」读时，一条坏数据会让列表变空，下一次保存就把其余的配置全部覆盖掉。
 * 有任何读不懂的内容时，原文件另存一份 `.unreadable`，因为之后的保存不会再带上它们。
 *
 * 写：先写同目录的临时文件再 rename，权限 0600（里面可能有 API key）。写到一半崩溃不会留下半个文件。
 */
export async function loadAgentConfigs(
  path: string,
): Promise<{ agents: AgentConfig[]; unreadable: number }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Agent 配置文件读取失败，按没有配置处理', error);
    return { agents: [], unreadable: 0 };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch {
    entries = undefined;
  }
  const agents: AgentConfig[] = [];
  let unreadable = Array.isArray(entries) ? 0 : 1;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const parsed = AgentConfigSchema.safeParse(entry);
    if (parsed.success) agents.push(parsed.data);
    else unreadable += 1;
  }
  if (unreadable) {
    const backup = `${path}.unreadable`;
    await copyFile(path, backup).catch(() => undefined);
    console.error(`Agent 配置文件有 ${unreadable} 处无法读取，已跳过；原文件另存为 ${backup}`);
  }
  return { agents, unreadable };
}

export async function saveAgentConfigs(
  path: string,
  agents: readonly AgentConfig[],
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(agents, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
