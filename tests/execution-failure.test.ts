import { describe, expect, it } from 'vitest';
import { BrowserError } from '../src/main/browser/errors';
import { HostError } from '../src/main/host/types';
import { executionFailureResult } from '../src/main/host/execution-failure';

describe('执行失败详情', () => {
  it.each([
    new BrowserError('STALE_ELEMENT', '目标元素已失效'),
    new HostError('LEASE_EXPIRED', 'Attachment 已到期'),
  ])('保留 $name 的 code 和 message', (error) => {
    expect(executionFailureResult(error)).toEqual({
      error: { code: error.code, message: error.message },
    });
  });

  it('普通异常不记录 code，message 最多 500 字符', () => {
    const error = Object.assign(new Error('错'.repeat(501)), { code: 'UNTRUSTED_CODE' });
    expect(executionFailureResult(error)).toEqual({ error: { message: '错'.repeat(500) } });
  });

  it('非 Error 的失败原因也保留文本', () => {
    expect(executionFailureResult('失败原因')).toEqual({ error: { message: '失败原因' } });
  });
});
