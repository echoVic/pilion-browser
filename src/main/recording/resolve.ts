import type { ElementRef, Observation, ObservedElement } from '../browser/types.js';
import type { StepTarget } from './types.js';

export type ResolveLevel = 'fingerprint' | 'exact' | 'normalized' | 'nth' | 'options';
export type ResolveResult =
  | { ok: true; ref: ElementRef; level: ResolveLevel }
  | { ok: false; reason: 'NO_MATCH' | 'AMBIGUOUS'; candidates: number };

type Row = Omit<ObservedElement, 'ref'> & { ref?: ElementRef };

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameKind(target: StepTarget, row: Row): boolean {
  return row.role === target.role && row.tagName === target.tagName;
}
function sameInputType(target: StepTarget, row: Row): boolean {
  return target.inputType === undefined || row.inputType === target.inputType;
}

/**
 * 按序降级，每一级都要求唯一命中；命中后仍交叉校验 role 与 tagName，
 * 所以 8 位指纹前缀撞车也撞不出问题。全部落空就交还，交还正好是 Agent 接手的时机。
 * 名字被扣下的目标（editable）只试指纹这一级。
 */
export function resolveTarget(target: StepTarget, observation: Observation): ResolveResult {
  const rows = observation.elements;

  if (target.fingerprint) {
    const byFingerprint = rows.filter(
      (row) =>
        row.ref.localFingerprint.slice(0, 8).toLowerCase() === target.fingerprint &&
        sameKind(target, row),
    );
    if (byFingerprint.length === 1)
      return { ok: true, ref: byFingerprint[0].ref, level: 'fingerprint' };
  }

  // 名字被扣下时绝不往下按名字找：空名或残缺的名字可能正好等于页面上另一个元素的名字，
  // 按名字匹配就会点到人没碰过的元素。指纹对不上就交还给人。
  if (target.editable) return { ok: false, reason: 'NO_MATCH', candidates: 0 };

  const exact = rows.filter(
    (row) => sameKind(target, row) && sameInputType(target, row) && row.name === target.name,
  );
  if (exact.length === 1) return { ok: true, ref: exact[0].ref, level: 'exact' };

  const wanted = normalizeName(target.name);
  const normalized = rows.filter(
    (row) =>
      sameKind(target, row) && sameInputType(target, row) && normalizeName(row.name) === wanted,
  );
  if (exact.length === 0 && normalized.length === 1)
    return { ok: true, ref: normalized[0].ref, level: 'normalized' };

  const duplicates = exact.length > 1 ? exact : normalized;
  if (duplicates.length > 1) {
    if (target.nth === undefined)
      return { ok: false, reason: 'AMBIGUOUS', candidates: duplicates.length };
    const picked = duplicates[target.nth - 1];
    if (!picked) return { ok: false, reason: 'NO_MATCH', candidates: duplicates.length };
    return { ok: true, ref: picked.ref, level: 'nth' };
  }

  if (target.tagName === 'select' && target.optionValues?.length) {
    const recorded = new Set(target.optionValues);
    const overlapping = rows.filter(
      (row) =>
        sameKind(target, row) && (row.optionValues ?? []).some((value) => recorded.has(value)),
    );
    if (overlapping.length === 1) return { ok: true, ref: overlapping[0].ref, level: 'options' };
    if (overlapping.length > 1)
      return { ok: false, reason: 'AMBIGUOUS', candidates: overlapping.length };
  }

  return { ok: false, reason: 'NO_MATCH', candidates: 0 };
}

/** 录制端：把 observe 的一行变成可存的目标描述。序号与指纹都从这一份 observe 里来。 */
export function toStepTarget(
  element: Row,
  all: ReadonlyArray<Row>,
): { target: StepTarget; duplicates: number } {
  const same = all.filter(
    (row) =>
      row.role === element.role && row.name === element.name && row.tagName === element.tagName,
  );
  const fingerprint = element.ref?.localFingerprint;
  const target: StepTarget = {
    role: element.role,
    name: element.name,
    tagName: element.tagName,
    ...(element.inputType ? { inputType: element.inputType } : {}),
    ...(element.optionValues?.length ? { optionValues: [...element.optionValues] } : {}),
    ...(same.length > 1 ? { nth: same.indexOf(element) + 1 } : {}),
    ...(fingerprint && /^[a-f0-9]{64}$/i.test(fingerprint)
      ? { fingerprint: fingerprint.slice(0, 8).toLowerCase() }
      : {}),
  };
  return { target, duplicates: same.length };
}
