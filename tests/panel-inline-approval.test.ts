import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ApprovalViewState } from '../src/shared/contracts';
import { InlineApproval } from '../src/renderer/InlineApproval';

const approval: ApprovalViewState = {
  approvalId: 'a1',
  tool: 'browser.click',
  summary: '点击「提交」',
  state: 'pending',
  nonce: 'n'.repeat(32),
  actionDigest: 'f'.repeat(64),
  allowedScopes: ['space', 'client'],
};
const render = (view: ApprovalViewState) =>
  renderToStaticMarkup(
    createElement(InlineApproval, { approval: view, count: 1, run: async () => true }),
  );
const disabledButtons = (html: string) => html.match(/<button[^>]*disabled=""/g)?.length ?? 0;

it('lets the person decide when the approval carries its nonce and digest', () => {
  const html = render(approval);
  expect(disabledButtons(html)).toBe(0);
  expect(html).not.toContain('缺少校验信息');
});

it.each([
  { ...approval, nonce: undefined },
  { ...approval, actionDigest: undefined },
])('says the approval cannot be handled here when it lacks its nonce or digest', (view) => {
  const html = render(view);
  expect(html).toContain('这条审批缺少校验信息，暂时无法在这里处理');
  // 拒绝、本任务允许、批准一次、始终允许此客户端：都点不了，而不是点了没反应。
  expect(disabledButtons(html)).toBe(4);
});
