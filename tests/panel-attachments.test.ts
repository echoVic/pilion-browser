import { expect, it } from 'vitest';
import { addImageAttachments, readImageAttachment } from '../src/renderer/composer/attachments';
import { MAX_IMAGES_PER_PROMPT } from '../src/shared/contracts';

const png = (name: string, size = 1024) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

async function errOf(p: ReturnType<typeof readImageAttachment>): Promise<string> {
  const r = await p;
  if (r.ok) throw new Error('expected error');
  return r.error;
}

it('渲染层本地拦截：类型/大小/空文件/张数', async () => {
  expect(
    await errOf(readImageAttachment(new File([''], 'a.txt', { type: 'text/plain' }), 0)),
  ).toMatch('不支持的图片类型');
  const huge = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
  expect(await errOf(readImageAttachment(huge, 0))).toMatch('单张 5MB');
  expect(
    await errOf(readImageAttachment(new File([], 'empty.png', { type: 'image/png' }), 0)),
  ).toBe('empty.png 是空文件');
  expect(await errOf(readImageAttachment(png('a.png'), 5))).toBe('一次最多附带 5 张图片');
});

/** 不依赖 FileReader 的读取替身：保留真实实现的张数规则，其余直接成功。 */
const fakeRead: typeof readImageAttachment = async (file, currentCount) =>
  currentCount >= MAX_IMAGES_PER_PROMPT
    ? { ok: false, error: `一次最多附带 ${MAX_IMAGES_PER_PROMPT} 张图片` }
    : { ok: true, attachment: { mimeType: 'image/png', data: 'aGk=', name: file.name } };

it('一次选多张图片：逐张累加，全部保留', async () => {
  const existing = [{ mimeType: 'image/png' as const, data: 'aGk=', name: 'old.png' }];
  const added = await addImageAttachments(
    existing,
    [png('a.png'), png('b.png'), png('c.png')],
    fakeRead,
  );
  expect(added.attachments.map((item) => item.name)).toEqual([
    'old.png',
    'a.png',
    'b.png',
    'c.png',
  ]);
  expect(added.errors).toEqual([]);
  // 入参不被改写：调用方靠长度变化判断要不要更新。
  expect(existing).toHaveLength(1);
});

it('张数上限在同一批内也生效，超出的逐张报原因', async () => {
  const files = Array.from({ length: MAX_IMAGES_PER_PROMPT + 2 }, (_, i) => png(`${i}.png`));
  const added = await addImageAttachments([], files, fakeRead);
  expect(added.attachments).toHaveLength(MAX_IMAGES_PER_PROMPT);
  expect(added.errors).toEqual(['一次最多附带 5 张图片', '一次最多附带 5 张图片']);
});

it('非图片文件直接跳过，不占名额也不报错', async () => {
  const added = await addImageAttachments(
    [],
    [new File(['x'], 'notes.txt', { type: 'text/plain' }), png('a.png')],
    fakeRead,
  );
  expect(added.attachments.map((item) => item.name)).toEqual(['a.png']);
  expect(added.errors).toEqual([]);
});
