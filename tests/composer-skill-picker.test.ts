import { describe, expect, it } from 'vitest';
import type { RecordingSummary } from '../src/shared/contracts.js';
import { filterSkills, skillInsertText } from '../src/renderer/composer/skill-picker.js';

function summary(partial: Partial<RecordingSummary>): RecordingSummary {
  return {
    id: 'x',
    name: '未命名',
    steps: 0,
    unsupported: 0,
    needsHuman: 0,
    recordedAt: '',
    distilled: true,
    hasEvents: false,
    ...partial,
  };
}

const skills: RecordingSummary[] = [
  summary({ id: 'open-gh', name: '打开 GitHub', about: '进入仓库首页', distilled: true }),
  summary({ id: 'hacker-news', name: 'Hacker News 速览', about: '刷首页标题', distilled: true }),
  summary({ id: 'draft', name: '还没提炼', distilled: false }),
  summary({ id: 'broken', name: '有错误', distilled: true, error: '解析失败' }),
];

describe('/ 技能选择器', () => {
  it('只列已提炼且无错误的技能', () => {
    const ids = filterSkills(skills, '').map((s) => s.id);
    expect(ids).toEqual(['open-gh', 'hacker-news']);
  });

  it('按名字或 about 过滤，大小写不敏感', () => {
    expect(filterSkills(skills, 'github').map((s) => s.id)).toEqual(['open-gh']);
    expect(filterSkills(skills, '刷首页').map((s) => s.id)).toEqual(['hacker-news']);
  });

  it('没有匹配返回空', () => {
    expect(filterSkills(skills, '不存在')).toEqual([]);
  });
});

describe('插入文案', () => {
  it('生成调用 browser.skills.play 的提示', () => {
    const text = skillInsertText({ id: 'open-gh', name: '打开 GitHub' });
    expect(text).toContain('browser.skills.play');
    expect(text).toContain('open-gh');
    expect(text).toContain('打开 GitHub');
  });
});
