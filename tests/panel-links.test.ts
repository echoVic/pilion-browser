import { expect, it } from 'vitest';
import { formatClock, safeExternalHref } from '../src/renderer/panel/links';

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
