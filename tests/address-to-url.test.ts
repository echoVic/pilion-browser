import { expect, it } from 'vitest';
import { addressToUrl } from '../src/renderer/ui';

it('reads host:port as a host, the way the main process URL policy does', () => {
  expect(addressToUrl('localhost:3000')).toBe('https://localhost:3000');
  expect(addressToUrl('localhost:3000/admin?tab=1')).toBe('https://localhost:3000/admin?tab=1');
  expect(addressToUrl('example.com:8080')).toBe('https://example.com:8080');
  expect(addressToUrl('example.com:8080/path')).toBe('https://example.com:8080/path');
});

it('keeps real schemes on the scheme path and sends other text to search', () => {
  expect(addressToUrl('http://localhost:3000')).toBe('http://localhost:3000');
  expect(addressToUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
  expect(addressToUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  expect(addressToUrl('localhost')).toBe('https://www.google.com/search?q=localhost');
});
