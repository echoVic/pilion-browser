import { expect, it } from 'vitest';
import { readImageAttachment } from '../src/renderer/composer/attachments';

const png = (name: string, size = 1024) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

async function errOf(p: ReturnType<typeof readImageAttachment>): Promise<string> {
  const r = await p;
  if (r.ok) throw new Error('expected error');
  return r.error;
}

it('渲染层本地拦截：类型/大小/空文件/张数', async () => {
  expect(await errOf(readImageAttachment(new File([''], 'a.txt', { type: 'text/plain' }), 0))).toMatch('不支持的图片类型');
  const huge = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
  expect(await errOf(readImageAttachment(huge, 0))).toMatch('单张 5MB');
  expect(await errOf(readImageAttachment(new File([], 'empty.png', { type: 'image/png' }), 0))).toBe('empty.png 是空文件');
  expect(await errOf(readImageAttachment(png('a.png'), 5))).toBe('一次最多附带 5 张图片');
});
