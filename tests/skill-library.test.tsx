// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordingSummary, SkillDetail } from '../src/shared/contracts';
import { SkillLibrary } from '../src/renderer/SkillLibrary';
import { revealLabel } from '../src/renderer/panel/links';

const summary = (id: string): RecordingSummary => ({
  id,
  name: `技能 ${id}`,
  steps: 1,
  unsupported: 0,
  needsHuman: 0,
  recordedAt: '2026-11-01T00:00:00Z',
  distilled: true,
  hasEvents: false,
});
const detail = (id: string): SkillDetail =>
  ({
    id,
    name: `技能 ${id}`,
    recordedAt: '2026-11-01T00:00:00Z',
    markdown: '',
    distilled: true,
    prose: `说明 ${id}`,
    steps: [{ index: 1, kind: 'navigate', text: `打开 ${id}`, raw: { kind: 'navigate' } }],
  }) as SkillDetail;

const read = vi.fn<(id: string) => Promise<SkillDetail>>();
const save = vi.fn(async () => {});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  read.mockReset();
  read.mockImplementation(async (id) => detail(id));
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: { skills: { read, save, events: vi.fn(async () => ({ lines: [] })) } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});

async function render(skills: RecordingSummary[]) {
  await act(async () => {
    root.render(
      createElement(SkillLibrary, {
        skills,
        busy: false,
        run: async (action: () => Promise<unknown>) => {
          await action();
          return true;
        },
        onPlay() {},
        agentConnected: false,
      }),
    );
  });
}
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);

it('puts each row button inside its list item', async () => {
  await render([summary('A'), summary('B')]);
  const items = container.querySelectorAll('[role="list"] > [role="listitem"]');
  expect(items).toHaveLength(2);
  for (const item of items)
    expect(item.querySelector(':scope > button.library-row')).not.toBeNull();
});

it('says the skill is loading, then says why it could not be read', async () => {
  let fail!: (cause: Error) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<SkillDetail>((_resolve, reject) => {
        fail = reject;
      }),
  );
  await render([summary('A')]);
  expect(container.querySelector('.skills-detail .skills-note')?.textContent).toBe('加载中…');
  await act(async () =>
    fail(new Error("Error invoking remote method 'skills:read': Error: skill.md 第 3 行坏了")),
  );
  expect(container.querySelector('.skills-detail .skills-error')?.textContent).toBe(
    '技能内容读不出来：skill.md 第 3 行坏了',
  );
});

it('drops the editor when the skill it was opened for is no longer selected', async () => {
  await render([summary('A'), summary('B')]);
  await act(async () => button('编辑')!.click());
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="技能说明"]')?.value).toBe(
    '说明 A',
  );
  // A 被别处删掉：选中行落到 B，A 的编辑器不能顶着 B 的 id 出现。
  await render([summary('B')]);
  expect(container.querySelector('[aria-label="技能说明"]')).toBeNull();
  expect(container.querySelector('.skills-detail')?.getAttribute('aria-label')).toBe('技能 B');
  expect(save).not.toHaveBeenCalled();
});

it('names the file manager by platform', () => {
  expect(revealLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('在 Finder 中显示');
  expect(revealLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('在文件夹中显示');
  expect(revealLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('在文件夹中显示');
});
