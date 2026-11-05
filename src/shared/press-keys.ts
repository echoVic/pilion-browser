/**
 * 浏览器按键白名单的单一来源：contracts 里的 PressKeySchema 和外部 CLI 的本地校验共用。
 *
 * 外部 CLI 是每次命令都要冷启动的进程，模块图里每多一个重依赖都要付启动时间；
 * `pilion press` 只需要这份字符串表，不应该为了 z.enum 把整个 zod 拉进来。
 */
export const PRESS_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  'Space',
] as const;

export type PressKey = (typeof PRESS_KEYS)[number];

export function isPressKey(value: string): value is PressKey {
  return (PRESS_KEYS as readonly string[]).includes(value);
}
