import { expect, it } from 'vitest';
import { approvalLine } from '../src/main/approval-text';

// 不在源码里直接写不可见字符：按码点拼出来。
const ch = (code: number) => String.fromCodePoint(code);

it('flattens every line breaker a page can smuggle into one line', () => {
  const breakers = [
    '\n',
    '\r\n',
    '\t',
    ch(0x0b),
    ch(0x0c),
    ch(0x85),
    ch(0x2028),
    ch(0x2029),
    ch(0x00),
    ch(0x1b),
    ch(0x7f),
  ];
  for (const breaker of breakers) {
    expect(approvalLine(`提交${breaker}站点：https://bank.example`, 200)).toBe(
      '提交 站点：https://bank.example',
    );
  }
});

it('removes bidi and zero-width controls that reorder or hide text', () => {
  for (const code of [0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069]) {
    expect(approvalLine(`a${ch(code)}b`, 200)).toBe('a b');
  }
});

it('collapses runs and trims the ends', () => {
  expect(approvalLine(`  a \n\n ${ch(0x2028)} b  `, 200)).toBe('a b');
});

it('caps at max characters with an ellipsis and leaves shorter values alone', () => {
  expect(approvalLine('x'.repeat(200), 200)).toBe('x'.repeat(200));
  const capped = approvalLine('x'.repeat(201), 200);
  expect([...capped]).toHaveLength(200);
  expect(capped).toBe(`${'x'.repeat(199)}…`);
});

it('counts code points, so an emoji is never split into a lone surrogate', () => {
  expect(approvalLine('😀'.repeat(10), 5)).toBe('😀😀😀😀…');
});
