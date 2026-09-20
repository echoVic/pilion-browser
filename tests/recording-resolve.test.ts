import { describe, expect, it } from 'vitest';
import type { ElementRef, Observation, ObservedElement } from '../src/main/browser/index';
import { resolveTarget, toStepTarget } from '../src/main/recording/index';

let counter = 0;
function element(
  partial: Partial<Omit<ObservedElement, 'ref'>> & { fingerprint?: string },
): ObservedElement {
  counter += 1;
  const ref: ElementRef = {
    id: `ref-${counter}`,
    tabId: 'tab-1',
    frameId: 'main',
    documentEpoch: 3,
    frameEpoch: 0,
    localFingerprint: partial.fingerprint ?? 'f'.repeat(64),
  };
  return {
    ref,
    role: partial.role ?? 'button',
    name: partial.name ?? 'Save',
    disabled: partial.disabled ?? false,
    tagName: partial.tagName ?? 'button',
    inputType: partial.inputType,
    optionValues: partial.optionValues,
    checked: partial.checked,
  };
}
function observation(elements: ObservedElement[]): Observation {
  return { observationId: 'obs-1', tabId: 'tab-1', documentEpoch: 3, elements };
}

describe('resolveTarget', () => {
  it('role + name + tagName 精确唯一命中', () => {
    const save = element({ name: '保存' });
    const result = resolveTarget(
      { role: 'button', name: '保存', tagName: 'button' },
      observation([element({ name: '取消' }), save]),
    );
    expect(result).toEqual({ ok: true, ref: save.ref, level: 'exact' });
  });

  it('指纹前缀优先于名字，页面改了按钮文案仍能命中', () => {
    const fp = 'a1b2c3d4' + '0'.repeat(56);
    const renamed = element({ name: '导出（新）', fingerprint: fp });
    const result = resolveTarget(
      { role: 'button', name: '导出', tagName: 'button', fingerprint: 'a1b2c3d4' },
      observation([element({ name: '取消' }), renamed]),
    );
    expect(result).toEqual({ ok: true, ref: renamed.ref, level: 'fingerprint' });
  });

  it('指纹命中但 role 或 tagName 变了不算', () => {
    const fp = 'a1b2c3d4' + '0'.repeat(56);
    const link = element({ name: '导出', role: 'link', tagName: 'a', fingerprint: fp });
    const result = resolveTarget(
      { role: 'button', name: '导出', tagName: 'button', fingerprint: 'a1b2c3d4' },
      observation([link]),
    );
    expect(result).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 0 });
  });

  it('名字只差空白与大小写时按归一化命中', () => {
    const target = element({ name: '  Export   CSV ' });
    const result = resolveTarget(
      { role: 'button', name: 'export csv', tagName: 'button' },
      observation([element({ name: 'Cancel' }), target]),
    );
    expect(result).toEqual({ ok: true, ref: target.ref, level: 'normalized' });
  });

  it('同名多个且没有 nth 时报 AMBIGUOUS', () => {
    const result = resolveTarget(
      { role: 'button', name: '查看', tagName: 'button' },
      observation([
        element({ name: '查看' }),
        element({ name: '查看' }),
        element({ name: '查看' }),
      ]),
    );
    expect(result).toEqual({ ok: false, reason: 'AMBIGUOUS', candidates: 3 });
  });

  it('同名多个且有 nth 时按文档顺序取第 nth 个', () => {
    const second = element({ name: '查看' });
    const result = resolveTarget(
      { role: 'button', name: '查看', tagName: 'button', nth: 2 },
      observation([element({ name: '查看' }), second, element({ name: '查看' })]),
    );
    expect(result).toEqual({ ok: true, ref: second.ref, level: 'nth' });
  });

  it('nth 超出候选数时报 NO_MATCH', () => {
    const result = resolveTarget(
      { role: 'button', name: '查看', tagName: 'button', nth: 5 },
      observation([element({ name: '查看' }), element({ name: '查看' })]),
    );
    expect(result).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 2 });
  });

  it('inputType 参与精确匹配', () => {
    const email = element({ role: 'textbox', name: '', tagName: 'input', inputType: 'email' });
    const result = resolveTarget(
      { role: 'textbox', name: '', tagName: 'input', inputType: 'email' },
      observation([
        element({ role: 'textbox', name: '', tagName: 'input', inputType: 'text' }),
        email,
      ]),
    );
    expect(result).toEqual({ ok: true, ref: email.ref, level: 'exact' });
  });

  it('select 名字变了但选项集合有交集时命中', () => {
    const month = element({
      role: 'combobox',
      name: '统计月份',
      tagName: 'select',
      optionValues: ['2026-08', '2026-09', '2026-10'],
    });
    const result = resolveTarget(
      {
        role: 'combobox',
        name: '月份',
        tagName: 'select',
        optionValues: ['2026-07', '2026-08', '2026-09'],
      },
      observation([
        element({ role: 'combobox', name: '地区', tagName: 'select', optionValues: ['cn'] }),
        month,
      ]),
    );
    expect(result).toEqual({ ok: true, ref: month.ref, level: 'options' });
  });

  it('select 选项交集命中多个时报 AMBIGUOUS 并带真实数量', () => {
    const rows = [
      element({
        role: 'combobox',
        name: '开始月',
        tagName: 'select',
        optionValues: ['2026-08', '2026-09'],
      }),
      element({
        role: 'combobox',
        name: '结束月',
        tagName: 'select',
        optionValues: ['2026-09', '2026-10'],
      }),
    ];
    const result = resolveTarget(
      { role: 'combobox', name: '月份', tagName: 'select', optionValues: ['2026-09'] },
      observation(rows),
    );
    expect(result).toEqual({ ok: false, reason: 'AMBIGUOUS', candidates: 2 });
  });

  it('一无所获时报 NO_MATCH', () => {
    const result = resolveTarget(
      { role: 'button', name: '导出', tagName: 'button' },
      observation([element({ name: '取消' })]),
    );
    expect(result).toEqual({ ok: false, reason: 'NO_MATCH', candidates: 0 });
  });
});

describe('toStepTarget', () => {
  it('唯一元素不带 nth，指纹取前 8 位小写', () => {
    const fp = 'ABCDEF01' + '0'.repeat(56);
    const only = element({ name: '保存', fingerprint: fp });
    expect(toStepTarget(only, [element({ name: '取消' }), only])).toEqual({
      target: { role: 'button', name: '保存', tagName: 'button', fingerprint: 'abcdef01' },
      duplicates: 1,
    });
  });

  it('同描述多个时带 nth，并报出重复数', () => {
    const first = element({ name: '查看' });
    const second = element({ name: '查看' });
    expect(toStepTarget(second, [first, second]).target.nth).toBe(2);
    expect(toStepTarget(second, [first, second]).duplicates).toBe(2);
  });

  it('非 sha256 形态的指纹不写入', () => {
    const odd = element({ name: '保存', fingerprint: 'button:save:1' });
    expect(toStepTarget(odd, [odd]).target.fingerprint).toBeUndefined();
  });

  it('select 带上 optionValues，input 带上 inputType', () => {
    const select = element({
      role: 'combobox',
      name: '月份',
      tagName: 'select',
      optionValues: ['a', 'b'],
    });
    expect(toStepTarget(select, [select]).target.optionValues).toEqual(['a', 'b']);
    const input = element({ role: 'textbox', name: '邮箱', tagName: 'input', inputType: 'email' });
    expect(toStepTarget(input, [input]).target.inputType).toBe('email');
  });
});
