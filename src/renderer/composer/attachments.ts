import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PROMPT,
  type PromptAttachment,
} from '../../shared/contracts.js';
import { parseDataUrl } from '../../shared/attachments.js';

export type AttachmentOutcome =
  | { ok: true; attachment: PromptAttachment }
  | { ok: false; error: string };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 本地先拦一道：类型、单张大小、总数。主进程还会用 Zod 复校，这里只是给更快、更友好的反馈，
 * 并在读文件前就拒绝明显不对的输入。
 */
export async function readImageAttachment(
  file: File,
  currentCount: number,
): Promise<AttachmentOutcome> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
    return { ok: false, error: `不支持的图片类型 ${file.type || file.name}，仅 png/jpeg/webp/gif` };
  if (file.size > MAX_IMAGE_BYTES)
    return {
      ok: false,
      error: `${file.name} 超过单张 5MB 限制（${(file.size / 1024 / 1024).toFixed(1)}MB）`,
    };
  if (file.size === 0) return { ok: false, error: `${file.name} 是空文件` };
  if (currentCount >= MAX_IMAGES_PER_PROMPT)
    return { ok: false, error: `一次最多附带 ${MAX_IMAGES_PER_PROMPT} 张图片` };
  let parsed: { mimeType: string; data: string } | undefined;
  try {
    parsed = parseDataUrl(await readAsDataUrl(file));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed) return { ok: false, error: `${file.name} 无法解码` };
  if (!IMAGE_MIME_TYPES.includes(parsed.mimeType as (typeof IMAGE_MIME_TYPES)[number]))
    return { ok: false, error: `不支持的图片类型 ${parsed.mimeType}` };
  return {
    ok: true,
    attachment: {
      mimeType: parsed.mimeType as PromptAttachment['mimeType'],
      data: parsed.data,
      name: file.name || '粘贴图片',
    },
  };
}
