import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { SkillProposalView } from '../src/shared/contracts';
import { SkillProposalPanel } from '../src/renderer/composer/SkillProposalPanel';

const proposal = (proposalId: string, conversationId: string): SkillProposalView => ({
  proposalId,
  conversationId,
  messageId: `m-${proposalId}`,
  name: `技能 ${proposalId}`,
  stepCount: 2,
  preview: `预览 ${proposalId}：第一步、第二步`,
});
const render = (conversationId: string | undefined) =>
  renderToStaticMarkup(
    createElement(SkillProposalPanel, {
      proposals: [proposal('p1', 'A'), proposal('p2', 'B')],
      conversationId,
      skills: [],
      run: async () => true,
    }),
  );

it('shows only the proposals the Agent made in this conversation', () => {
  const html = render('A');
  expect(html).toContain('技能 p1');
  expect(html).not.toContain('技能 p2');
  expect(render(undefined)).toBe('');
});

it('lets the person read the proposed change, collapsed by default', () => {
  const html = render('A');
  expect(html).toMatch(/<details class="appr-details"><summary>查看修改内容/);
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(html).toContain('预览 p1：第一步、第二步');
});
