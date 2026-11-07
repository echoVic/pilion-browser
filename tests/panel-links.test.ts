import { expect, it } from 'vitest';
import { formatClock, localFileHref, safeExternalHref } from '../src/renderer/panel/links';

it('safeExternalHref 只放行 http(s)', () => {
  expect(safeExternalHref('https://example.com/x')).toBe('https://example.com/x');
  expect(safeExternalHref('http://localhost:3000')).toBe('http://localhost:3000');
  expect(safeExternalHref('HTTPS://Example.COM/x')).toBe('HTTPS://Example.COM/x');
  expect(safeExternalHref('ftp://example.com')).toBeUndefined();
  expect(safeExternalHref('javascript:alert(1)')).toBeUndefined();
  expect(safeExternalHref('mailto:a@b.c')).toBeUndefined();
  expect(safeExternalHref('/relative/path')).toBeUndefined();
  expect(safeExternalHref(undefined)).toBeUndefined();
});

it('formatClock 输出 HH:MM', () => {
  expect(formatClock('2026-10-14T14:05:00+08:00')).toMatch(/^\d{2}:\d{2}$/);
  expect(formatClock('not-a-date')).toBe('');
});

it('localFileHref 只接受可安全打开的本地文件链接', () => {
  expect(localFileHref('telegram-ai-relay-market-2026-11-07.md')).toBe(
    'telegram-ai-relay-market-2026-11-07.md',
  );
  expect(localFileHref('./reports/weekly.md')).toBe('./reports/weekly.md');
  expect(localFileHref('/Users/me/report.pdf')).toBe('/Users/me/report.pdf');
  expect(localFileHref('file:///Users/me/report.md')).toBe('file:///Users/me/report.md');
  expect(localFileHref('notes.txt#L10')).toBe('notes.txt#L10');
  // 网页、其它协议、锚点、没有扩展名的路径都不当本地文件。
  expect(localFileHref('https://example.com/a.md')).toBeUndefined();
  expect(localFileHref('javascript:alert(1)')).toBeUndefined();
  expect(localFileHref('mailto:a@b.c')).toBeUndefined();
  expect(localFileHref('#section')).toBeUndefined();
  expect(localFileHref('/usr/local/bin/tool')).toBeUndefined();
  expect(localFileHref(undefined)).toBeUndefined();
});
