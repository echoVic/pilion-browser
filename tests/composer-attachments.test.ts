import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGES_PER_PROMPT,
  MAX_IMAGE_BYTES,
  PromptAttachmentSchema,
  TaskInputSchema,
} from '../src/shared/contracts.js';
import { parseDataUrl, promptContents } from '../src/shared/attachments.js';

const png = { mimeType: 'image/png' as const, data: 'aGVsbG8', name: 'a.png' };

describe('图片附件 Zod 校验', () => {
  it('拒绝非白名单类型', () => {
    expect(PromptAttachmentSchema.safeParse({ ...png, mimeType: 'image/bmp' }).success).toBe(false);
    expect(PromptAttachmentSchema.safeParse({ ...png, mimeType: 'image/svg+xml' }).success).toBe(
      false,
    );
  });

  it('接受白名单 png/jpeg/webp/gif', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const)
      expect(PromptAttachmentSchema.safeParse({ ...png, mimeType }).success).toBe(true);
  });

  it('拒绝超过单张字节上限的 base64', () => {
    const tooBig = { ...png, data: 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 1) * 4) / 3)) };
    expect(PromptAttachmentSchema.safeParse(tooBig).success).toBe(false);
  });

  it('拒绝非 base64 数据', () => {
    expect(PromptAttachmentSchema.safeParse({ ...png, data: 'not base64!!' }).success).toBe(false);
  });

  it('任务附件张数上限', () => {
    const attachments = Array.from({ length: MAX_IMAGES_PER_PROMPT + 1 }, () => png);
    expect(TaskInputSchema.safeParse({ text: 'hi', attachments }).success).toBe(false);
    expect(
      TaskInputSchema.safeParse({ text: 'hi', attachments: attachments.slice(0, 5) }).success,
    ).toBe(true);
  });
});

describe('ACP image content block 组装', () => {
  it('图片块在前、文字块在后', () => {
    const blocks = promptContents('看这张图', [png]);
    expect(blocks).toEqual([
      { type: 'image', data: 'aGVsbG8', mimeType: 'image/png', uri: 'a.png' },
      { type: 'text', text: '看这张图' },
    ]);
  });

  it('纯文字不留空 text 块', () => {
    expect(promptContents('   ', [])).toEqual([]);
    expect(promptContents('hi', [])).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('data URL 解析', () => {
  it('拆出 mimeType 与 base64（去掉空白）', () => {
    expect(parseDataUrl('data:image/webp;base64,  YWJjZA==  ')).toEqual({
      mimeType: 'image/webp',
      data: 'YWJjZA==',
    });
  });
  it('拒绝非 data URL 或非 base64', () => {
    expect(parseDataUrl('https://x/y.png')).toBeUndefined();
    expect(parseDataUrl('data:image/png,plain')).toBeUndefined();
  });
});
