import { OBSERVE_SELECTOR, PRESS_KEYS } from '../browser/types.js';
import { MAX_URL_LENGTH } from './types.js';

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
 *   { kind: 'edit',   url, index, el, length, at }         // 富文本；只报字符数，不报内容
 *   { kind: 'scroll', url, x, y, at }                      // 节流到 400ms 一条，iframe 里不报
 *   { kind: 'unsupported', url, reason: 'iframe' | 'out-of-scope' | 'gesture', el?, at }
 * el = { tagName, role, name, inputType?, optionValues?, checked?, duplicates?, position?, editable?, split? }
 * editable = 名字可能取自可编辑文字（富文本编辑区）；这时 name 已经跳过编辑宿主，不含人打的字。
 * split = 带 editable、name 不空，而按改动之前的路径算的名字（带着打的字）里没有连着的 name。
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
  const URL_LIMIT = ${MAX_URL_LENGTH};
  const href = () => {
    try {
      const raw = String(location.href);
      return raw.length > URL_LIMIT ? raw.slice(0, URL_LIMIT) : raw;
    } catch (_) { return ''; }
  };
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
  // 编辑宿主：写了 contenteditable 且值不是 "false"。宿主的整棵子树都是人能打字的地方。
  const EDITING_HOST = '[contenteditable]:not([contenteditable="false"])';
  const isHost = (node) => {
    const value = node.getAttribute('contenteditable');
    return value !== null && value !== 'false';
  };
  // 整份文档开着 designMode 时处处都能打字。
  const designing = (node) => {
    try { return lower((node.ownerDocument || document).designMode) === 'on'; } catch (_) { return false; }
  };
  // 扁平树上的父节点：分配进插槽的走插槽，影子根里的走宿主。closest 只沿 DOM 走，这两种都看不到。
  const flatParent = (node) => node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
  // 自己身处编辑区：自己或扁平树上的祖先是编辑宿主（编辑区里的链接、提及标签、分配进影子编辑区插槽的内容），
  // 或者整份文档开着 designMode。
  const inHost = (node) => {
    if (designing(node)) return true;
    for (let at = node; at; at = flatParent(at)) if (at.nodeType === 1 && isHost(at)) return true;
    return false;
  };
  // 与 textContent 同序拼出文字，只是整棵跳过编辑宿主，也跳过分配进编辑区插槽的内容。
  // 只给带标记的元素用，普通元素照旧读 textContent。
  const plainText = (root) => {
    let out = '';
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.assignedSlot && inHost(node.assignedSlot)) continue;
      if (node.nodeType === 3 || node.nodeType === 4) { out += node.nodeValue || ''; continue; }
      if (node.nodeType !== 1 || isHost(node)) continue;
      const kids = node.childNodes || [];
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
    return out;
  };
  // aria-labelledby、aria-owns 指到的元素与 label：都可能把编辑区里的字、密码框的值借给这个元素当名字。
  // aria-owns 把别处的元素挂到它名下，可访问性树按内容取名时连它们一起读。
  const labelSources = (el) => {
    const out = [];
    const doc = el.ownerDocument;
    ['aria-labelledby', 'aria-owns'].forEach((attr) => {
      const ids = el.getAttribute(attr);
      if (ids && doc && doc.getElementById)
        ids.split(/\\s+/).forEach((one) => { const node = doc.getElementById(one); if (node) out.push(node); });
    });
    if (el.labels) Array.from(el.labels).forEach((label) => out.push(label));
    return out;
  };
  // 子树里有人打字或填密码的地方：编辑宿主，或者 isSecret 认定的密码、验证码框（except 是正在判定的元素自己）。
  const sensitiveIn = (scope, except) => {
    if (scope.querySelector(EDITING_HOST)) return true;
    const inputs = scope.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i += 1) if (inputs[i] !== except && isSecret(inputs[i])) return true;
    return false;
  };
  // 开放影子根里的同样两种。querySelector 进不去影子根，只能逐个元素看 shadowRoot，要摸遍整棵子树。
  const sensitiveInShadow = (scope, except) => {
    const pending = [];
    const visit = (node) => { if (node.shadowRoot) pending.push(node.shadowRoot); };
    visit(scope);
    scope.querySelectorAll('*').forEach(visit);
    while (pending.length) {
      const shadow = pending.pop();
      if (sensitiveIn(shadow, except)) return true;
      shadow.querySelectorAll('*').forEach(visit);
    }
    return false;
  };
  const touches = (node, deep, except) =>
    inHost(node) || sensitiveIn(node, except) || (deep && sensitiveInShadow(node, except));
  // 名字可能取自人打的字或密码框的值：自己身处编辑区，子树里有编辑宿主或密码、验证码框，或者 aria-labelledby、
  // aria-owns、label 指向这样的元素（或者就是密码、验证码框，包括 aria-labelledby 连自己也算进去的密码、验证码框：
  // 浏览器取名时会读进它自己的值）。deep 才进开放影子根：那一步要摸遍子树，只给正在描述的元素做，
  // 不进同名计数那一圈。判不出来就当它是：宁可扣下名字，也不冒险带出正文。
  const editing = (el, deep) => {
    try {
      return touches(el, deep, el) || labelSources(el).some((src) => isSecret(src) || touches(src, deep, el));
    } catch (_) { return true; }
  };
  const labelText = (el, clean) => {
    const read = clean ? (node) => (inHost(node) ? '' : plainText(node)) : (node) => node.textContent;
    try {
      const id = el.getAttribute('aria-labelledby');
      if (id && el.ownerDocument && el.ownerDocument.getElementById) {
        const parts = id.split(/\\s+/).map((one) => el.ownerDocument.getElementById(one)).filter(Boolean);
        if (parts.length) return parts.map(read).join(' ');
      }
      if (el.labels && el.labels.length) return Array.from(el.labels).map(read).join(' ');
    } catch (_) {}
    return '';
  };
  // WAI-ARIA 1.2 里可访问名取自内容的角色。其余角色（表单、对话框、应用等）的名字只来自作者给的标签，
  // 浏览器不拿内容给它们取名：没有标签的登录表单、登录弹窗，可访问性树里的名字是空串。
  const NAMED_FROM_CONTENT = new Set(['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem']);
  const namedFromContent = (el) => NAMED_FROM_CONTENT.has(lower(el.getAttribute('role') || implicitRole(el)));
  // clean 为真（带标记的元素）时，aria-labelledby 与 label 只读编辑宿主之外的字；元素自己在编辑宿主里，或者它的角色
  // 不从内容取名，就完全不从内容取名，后者的干净名因此与可访问性树的名字一致。clean 为假时每一步都与原来一样，
  // 内容仍直接读 textContent。
  const accessibleName = (el, clean) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return text(aria);
    const labelled = text(labelText(el, clean));
    if (labelled) return labelled;
    const tag = lower(el.tagName);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = lower(el.type);
      if (type === 'button' || type === 'submit' || type === 'reset') return text(el.value);
      return text(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
    }
    const content = !clean ? el.textContent : inHost(el) || !namedFromContent(el) ? '' : plainText(el);
    return text(content) || text(el.getAttribute('title')) || text(el.getAttribute('alt'));
  };
  const describe = (el) => {
    const tagName = lower(el.tagName);
    const editable = editing(el, true);
    const out = { tagName, role: el.getAttribute('role') || implicitRole(el), name: accessibleName(el, editable) };
    if (tagName === 'input') out.inputType = lower(el.type) || 'text';
    if (tagName === 'select' && el.options) out.optionValues = Array.from(el.options, (o) => String(o.value)).slice(0, 200);
    if (tagName === 'input' && (out.inputType === 'checkbox' || out.inputType === 'radio')) out.checked = Boolean(el.checked);
    try {
      // 不带标记的元素照旧拿各家原来的名字比，同名计数与以前逐字节相同。带标记的元素拿干净名比：别的元素也各按
      // 自己该走的路径取名，但只做不进影子根的判定，免得在大页面上逐个摸子树；它自己直接用算好的名字，
      // 一定数得到自己（position 不会落成 0）。
      const nameOf = editable ? (other) => (other === el ? out.name : accessibleName(other, editing(other, false))) : accessibleName;
      const all = Array.from(document.querySelectorAll(SELECTOR));
      const same = all.filter((other) => lower(other.tagName) === tagName && (other.getAttribute('role') || implicitRole(other)) === out.role && nameOf(other) === out.name);
      if (same.length > 1) { out.duplicates = same.length; out.position = same.indexOf(el) + 1; }
    } catch (_) {}
    if (editable) out.editable = true;
    // 干净名不空时，在页面里按改动之前的路径再算一遍名字（带着人打的字）：它里面没有连着的干净名（最常见的是
    // 打的字夹在干净名中间），observe 里名字等于干净名的一行就证明不了身份，可能是打字之前取的名，也可能是
    // 别的元素；改动之前拿这个名字去比，也对不上那一行。只报这一位，原来的名字不出页面。判不出来就当它是。
    if (editable && out.name) {
      try { if (lower(accessibleName(el, false)).indexOf(lower(out.name)) < 0) out.split = true; } catch (_) { out.split = true; }
    }
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
    // 焦点在按钮上按 Enter/Space、或文本框里回车隐式提交表单，浏览器会补发一个 detail 为 0
    // 的可信 click。那一下已经由 press 步骤记下了，不能再算一次点击。
    if (kind === 'click' && event.detail === 0) return;
    // pointerdown 与 click 成对出现，内嵌框架只由 click 报一次。
    if (inFrame) { if (kind === 'click') unsupported('iframe'); return; }
    const el = scoped(event.target);
    if (!el) { if (kind === 'click') unsupported('out-of-scope', event.target); return; }
    emit(kind, el);
  };
  on('pointerdown', pointerLike('pointer'));
  on('click', pointerLike('click'));

  const SCROLL_MS = 400;
  let lastScroll = 0;
  on('scroll', () => {
    if (inFrame) return;
    const at = now();
    if (at - lastScroll < SCROLL_MS) return;
    lastScroll = at;
    send({ kind: 'scroll', url: href(), at, x: Math.round(w.scrollX || 0), y: Math.round(w.scrollY || 0) });
  });

  // iframe 里的输入类事件只报一次：每个键都报会把日志灌满。
  let framedInputReported = false;
  const framedInput = () => {
    if (framedInputReported) return;
    framedInputReported = true;
    unsupported('iframe');
  };

  on('focusin', (event) => {
    const el = scoped(event.target);
    if (el && isSecret(el)) emit('secret', el, { otp: isOtp(el) });
  });
  on('input', (event) => {
    if (inFrame) { framedInput(); return; }
    const raw = event.target;
    // contenteditable 不在 OBSERVE_SELECTOR 里，scoped() 会返回 null，
    // 所以这一支必须在 scoped 的提前返回之前，否则富文本输入永远录不到。
    if (raw && raw.isContentEditable) {
      // 密码/验证码字段哪怕把自己报成 contenteditable，也不能从这条岔路漏出长度。
      if (isSecret(raw)) { emit('secret', raw, { otp: isOtp(raw) }); return; }
      // describe() 对编辑宿主已经跳过了内容与 aria-labelledby 里的编辑区，但 aria-label、title、alt
      // 照用，它们仍可能镜像打进去的正文；这是编辑宿主自己的载荷，所以在这里把名字整个抹掉。
      send({
        kind: 'edit',
        url: href(),
        index: indexOf(raw),
        el: Object.assign({}, describe(raw), { name: '' }),
        at: now(),
        length: String(raw.textContent || '').length,
      });
      return;
    }
    const el = scoped(raw);
    if (!el) return;
    const tag = lower(el.tagName);
    if (tag !== 'input' && tag !== 'textarea') return;
    const type = lower(el.type);
    if (type === 'checkbox' || type === 'radio' || type === 'file') return;
    if (isSecret(el)) { emit('secret', el, { otp: isOtp(el) }); return; }
    emit('input', el, { value: String(el.value).slice(0, 100000) });
  });
  on('change', (event) => {
    if (inFrame) { framedInput(); return; }
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
    if (inFrame) { framedInput(); return; }
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
