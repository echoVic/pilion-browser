import { expect, it } from 'vitest';
import { actionBlocked, LOCKED_WHILE_DRIVING } from '../src/renderer/shell-actions';

const page = { driving: false, home: false };

it('does nothing for ⌘F on the new-tab page, where there is no page to search', () => {
  expect(actionBlocked('find', { ...page, home: true })).toBe(true);
  expect(actionBlocked('find', page)).toBe(false);
  // 新标签页上其它动作照常可用。
  expect(actionBlocked('newTab', { ...page, home: true })).toBe(false);
  expect(actionBlocked('focusAddress', { ...page, home: true })).toBe(false);
});

it('locks find with the other page controls while the Agent drives or a skill replays', () => {
  expect(LOCKED_WHILE_DRIVING.has('find')).toBe(true);
  for (const action of ['find', 'reload', 'back', 'zoomIn'] as const)
    expect(actionBlocked(action, { ...page, driving: true })).toBe(true);
  expect(actionBlocked('takeOver', { ...page, driving: true })).toBe(false);
  expect(actionBlocked('cancelTask', { ...page, driving: true })).toBe(false);
});
