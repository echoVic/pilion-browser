import { OBSERVE_SELECTOR, PRESS_KEYS } from '../browser/types.js';

export const RECORDER_WORLD = 'pilion-recorder';
const BINDING_PATTERN = /^pilion_[a-f0-9]{16}$/;

/**
 * 隔离世界里跑的固定脚本。它与页面共享 DOM，但页面 JS 看不到它的变量，也调用不了它的 binding；
 * isTrusted 过滤让页面伪造不出「人类动作」。
 *
 * 发出的消息（JSON 字符串）：
 *   { kind: 'pointer' | 'click', url, index, el, at }
 *   { kind: 'input',  url, index, el, value, at }
 *   { kind: 'select', url, index, el, value, at }
 *   { kind: 'check',  url, index, el, checked, at }
 *   { kind: 'key',    url, index, el, key, shift, at }
 *   { kind: 'secret', url, index, el, otp, at }           // 值与长度都不发
 *   { kind: 'unsupported', url, reason: 'iframe' | 'out-of-scope' | 'gesture', el?, at }
 * el = { tagName, role, name, inputType?, optionValues?, checked?, duplicates?, position? }
 * index = 元素在 document.querySelectorAll(OBSERVE_SELECTOR) 里的序号，-1 表示不在其中。
 */
export function buildRecorderScript(bindingName: string): string {
  if (!BINDING_PATTERN.test(bindingName)) throw new Error('录制 binding 名不合规');
  return `(() => {
  const w = typeof window !== 'undefined' ? window : globalThis;
  if (w.__pilionRecorder) return;
  w.__pilionRecorder = true;
  const SELECTOR = ${JSON.stringify(OBSERVE_SELECTOR)};
  const KEYS = new Set(${JSON.stringify(PRESS_KEYS)});
  const send = (payload) => {
    try { globalThis[${JSON.stringify(bindingName)}](JSON.stringify(payload)); } catch (_) {}
  };
  const now = () => Date.now();
  const href = () => { try { return String(location.href); } catch (_) { return ''; } };
  const inFrame = (() => { try { return w.top !== w; } catch (_) { return true; } })();
  const text = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
  const lower = (s) => String(s || '').toLowerCase();

  const implicitRole = (el) => {
    const tag = lower(el.tagName);
    const type = lower(el.type);
    if (tag === 'a') return el.getAttribute && el.getAttribute('href') !== null ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return 'generic';
  };
  const labelText = (el) => {
    try {
      const id = el.getAttribute('aria-labelledby');
      if (id && el.ownerDocument && el.ownerDocument.getElementById) {
        const parts = id.split(/\\s+/).map((one) => el.ownerDocument.getElementById(one)).filter(Boolean);
        if (parts.length) return parts.map((p) => p.textContent).join(' ');
      }
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent).join(' ');
    } catch (_) {}
    return '';
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return text(aria);
    const labelled = text(labelText(el));
    if (labelled) return labelled;
    const tag = lower(el.tagName);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = lower(el.type);
      if (type === 'button' || type === 'submit' || type === 'reset') return text(el.value);
      return text(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
    }
    return text(el.textContent) || text(el.getAttribute('title')) || text(el.getAttribute('alt'));
  };
  const describe = (el) => {
    const tagName = lower(el.tagName);
    const out = { tagName, role: el.getAttribute('role') || implicitRole(el), name: accessibleName(el) };
    if (tagName === 'input') out.inputType = lower(el.type) || 'text';
    if (tagName === 'select' && el.options) out.optionValues = Array.from(el.options, (o) => String(o.value)).slice(0, 200);
    if (tagName === 'input' && (out.inputType === 'checkbox' || out.inputType === 'radio')) out.checked = Boolean(el.checked);
    try {
      const all = Array.from(document.querySelectorAll(SELECTOR));
      const same = all.filter((other) => lower(other.tagName) === tagName && (other.getAttribute('role') || implicitRole(other)) === out.role && accessibleName(other) === out.name);
      if (same.length > 1) { out.duplicates = same.length; out.position = same.indexOf(el) + 1; }
    } catch (_) {}
    return out;
  };
  const indexOf = (el) => {
    try { return Array.prototype.indexOf.call(document.querySelectorAll(SELECTOR), el); } catch (_) { return -1; }
  };
  const scoped = (target) => {
    if (!target || typeof target.closest !== 'function') return null;
    try { return target.closest(SELECTOR); } catch (_) { return null; }
  };
  const isSecret = (el) => {
    if (lower(el.tagName) !== 'input') return false;
    if (lower(el.type) === 'password') return true;
    return lower(el.getAttribute('autocomplete')).indexOf('one-time-code') >= 0;
  };
  const isOtp = (el) => lower(el.getAttribute('autocomplete')).indexOf('one-time-code') >= 0;
  const emit = (kind, el, extra) => send(Object.assign({ kind, url: href(), index: indexOf(el), el: describe(el), at: now() }, extra || {}));
  const unsupported = (reason, el) => send({ kind: 'unsupported', url: href(), reason, el: el ? describe(el) : undefined, at: now() });
  const on = (type, handler) => document.addEventListener(type, (event) => {
    if (!event || !event.isTrusted) return;
    try { handler(event); } catch (_) {}
  }, { capture: true, passive: true });

  const pointerLike = (kind) => (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (inFrame) { unsupported('iframe'); return; }
    const el = scoped(event.target);
    if (!el) { if (kind === 'click') unsupported('out-of-scope', event.target); return; }
    emit(kind, el);
  };
  on('pointerdown', pointerLike('pointer'));
  on('click', pointerLike('click'));

  on('focusin', (event) => {
    const el = scoped(event.target);
    if (el && isSecret(el)) emit('secret', el, { otp: isOtp(el) });
  });
  on('input', (event) => {
    const el = scoped(event.target);
    if (!el) return;
    const tag = lower(el.tagName);
    if (tag !== 'input' && tag !== 'textarea') return;
    const type = lower(el.type);
    if (type === 'checkbox' || type === 'radio' || type === 'file') return;
    if (isSecret(el)) { emit('secret', el, { otp: isOtp(el) }); return; }
    emit('input', el, { value: String(el.value).slice(0, 100000) });
  });
  on('change', (event) => {
    const el = scoped(event.target);
    if (!el) return;
    const tag = lower(el.tagName);
    if (tag === 'select') { emit('select', el, { value: String(el.value) }); return; }
    if (tag === 'input') {
      const type = lower(el.type);
      if (type === 'checkbox' || type === 'radio') emit('check', el, { checked: Boolean(el.checked) });
    }
  });
  on('keydown', (event) => {
    const el = scoped(event.target);
    if (!el) return;
    const key = event.key === ' ' ? 'Space' : event.key;
    if (!KEYS.has(key)) return;
    const tag = lower(el.tagName);
    const editable = tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(lower(el.type)));
    if (editable && key !== 'Enter' && key !== 'Escape') return;
    emit('key', el, { key, shift: Boolean(event.shiftKey) });
  });
  on('dragstart', (event) => unsupported('gesture', scoped(event.target) || event.target));
  on('contextmenu', (event) => unsupported('gesture', scoped(event.target) || event.target));
})();`;
}
