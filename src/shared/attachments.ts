import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PromptAttachment } from './contracts.js';

/**
 * 把已校验过的附件拼成 ACP prompt 的 content block 序列。
 * 约定：图片块在前、文字块在后——多数 Agent 先看图再读指令更自然；顺序对协议本身无要求。
 * 这里不做任何校验（调用方已过 Zod），只做形状转换，因此是纯函数、可单测。
 */
export function promptContents(
  text: string,
  attachments: readonly PromptAttachment[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = attachments.map((attachment) => ({
    type: 'image',
    data: attachment.data,
    mimeType: attachment.mimeType,
    uri: attachment.name,
  }));
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
}

/** 从 data: URL（浏览器 FileReader 产物）拆出 mimeType、base64 与文件名兜底。 */
export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+)(;base64)?,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
  if (!match) return undefined;
  const [, mimeType, base64, data] = match;
  if (!base64) return undefined;
  return { mimeType, data: data.replace(/\s/g, '') };
}
