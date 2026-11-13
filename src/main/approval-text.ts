/**
 * 审批摘要在 <pre> 里一行一项地展示，人据此决定批不批。来自页面的字符串（元素名、role、
 * 输入类型、表单目标、选项值）是页面自己写的：带上换行、U+2028/2029 或控制字符，就能在摘要里
 * 伪造出「站点：」「数据流：」之类看起来可信的行；双向控制符还能把一行显示得颠倒错乱。
 * 这里把它们一律摊成一行再截断，页面最多只能占住自己那一格。
 */
const LINE_BREAKERS = /[\s\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069]+/gu;

/** 摊成一行（空白、控制字符、行/段分隔符、双向控制符都换成一个空格），超过 max 个字符时截断并以「…」结尾。 */
export function approvalLine(value: string, max: number): string {
  const flat = value.replace(LINE_BREAKERS, ' ').trim();
  // 按码点截，不把一个 emoji 劈成半个代理对。
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}
