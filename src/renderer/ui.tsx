import type { ButtonHTMLAttributes } from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { SEARCH_ENGINES, type SearchEngine } from '../shared/search-engines';
import type { Theme } from '../shared/settings';

type CheckboxProps = Omit<React.ComponentProps<typeof CheckboxPrimitive.Root>, 'asChild'>;

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root className={clsx('pilion-checkbox', className)} {...props}>
      <CheckboxPrimitive.Indicator className="pilion-checkbox-indicator">
        <Check size={11} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

type SwitchProps = Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, 'asChild'>;

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root className={clsx('pilion-switch', className)} {...props}>
      <SwitchPrimitive.Thumb className="pilion-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  ariaLabel,
  className,
  triggerRef,
}: {
  value: string;
  onValueChange(value: string): void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        ref={triggerRef}
        className={clsx('pilion-select-trigger', className)}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="pilion-select-icon">
          <ChevronDown size={12} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="pilion-select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="pilion-select-item"
                data-value={option.value}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="pilion-select-indicator">
                  <Check size={12} strokeWidth={2.5} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogOverlay = DialogPrimitive.Overlay;
export const DialogContent = DialogPrimitive.Content;
export const DialogTitle = DialogPrimitive.Title;

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      className={clsx('icon-button', props.className)}
      aria-label={label}
      // 调用方给了更具体的提示（操作中、限制说明）就用它；没给才退回到 label。
      title={props.title ?? label}
    >
      {children}
    </button>
  );
}
/**
 * The Pilion wordmark: the whole word as one piece of artwork, its P being the
 * mark itself (a lowercase p whose bowl is an orbit, with the satellite nested in
 * the ring's gap), so nothing can drift out of line the way an icon beside a text
 * node does. Every glyph is a path, rect or circle — no font is involved.
 * Monochrome except the satellite, which takes the theme's accent.
 *
 * Coordinates are the mark's own 24-unit grid, shifted into the wordmark's box,
 * so the ring centres on (13, 9.6). Give it a height and the viewBox supplies
 * the width.
 */
export function PilionWordmark({ height = 40 }: { height?: number }) {
  return (
    <svg height={height} viewBox="0 0 70.7 25.77" role="img" aria-label="Pilion">
      <g transform="translate(-5.6 2.77)" fill="currentColor" stroke="none">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth={3.6}
          strokeLinecap="butt"
          strokeLinejoin="round"
        >
          <path d="M7.4 22.99V9.6A5.6 5.6 0 0 1 15.3 4.5" />
          <path d="M18.6 9.6A5.6 5.6 0 0 1 7.4 9.6" />
          <circle cx="51.79" cy="9.6" r="5.6" />
          <path d="M63.3 17V9.6A5.6 5.6 0 0 1 74.5 9.6V17" />
        </g>
        <circle cx="13" cy="9.6" r="1.3" />
        <circle cx="17.96" cy="6.4" r="2" fill="var(--accent)" />
        <rect x="22.59" y="2.2" width="3.6" height="14.8" />
        <circle cx="24.39" cy="-0.77" r="2" />
        <rect x="30.34" y="-2.77" width="3.6" height="19.77" />
        <rect x="38.08" y="2.2" width="3.6" height="14.8" />
        <circle cx="39.88" cy="-0.77" r="2" />
      </g>
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <PilionWordmark />
    </div>
  );
}
export function hostname(url?: string): string {
  if (!url || url === 'about:blank') return '新标签页';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
/**
 * IPC 拒绝时 Electron 会把主进程那句话裹进 "Error invoking remote method ..."，
 * 人要看的只有里面那句中文，所以统一在这里剥掉外壳（含 BrowserError 等具名错误）。
 */
export function failureText(cause: unknown): string {
  return cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method '[^']+': [A-Za-z_$][\w$]*: /, '')
    : String(cause);
}
/**
 * 「主机:端口」开头（localhost:3000、example.com:8080/path）看着像协议，其实是主机。
 * 与主进程 url-policy 的 hasScheme 同一条规则：冒号后只跟端口号的不算协议，补 https://。
 */
const HOST_PORT = /^[a-z][a-z\d.+-]*:\d+(?:[/?#]|$)/i;
export function addressToUrl(input: string, engine: SearchEngine = 'google'): string {
  const text = input.trim();
  const hostPort = HOST_PORT.test(text);
  if (!hostPort && /^[a-z][a-z\d+.-]*:/i.test(text)) return text;
  if (!/\s/.test(text) && (hostPort || text.includes('.'))) return `https://${text}`;
  return `${SEARCH_ENGINES[engine].url}${encodeURIComponent(text)}`;
}
export const statusCopy = {
  not_configured: '未连接',
  starting: '连接中',
  ready: '已就绪',
  running: '执行中',
  stopping: '停止中',
  error: '连接失败',
  disconnected: '未连接',
};
/**
 * 主题以 settings.json 为准；localStorage 只留一份副本，让窗口在设置到达之前先用上次的主题，
 * 也是旧版主题迁进 settings.json 时的来源。
 */
export function cachedTheme(): Theme {
  const stored = localStorage.getItem('pilion-theme');
  return stored === 'dark' || stored === 'light' ? stored : 'auto';
}
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('pilion-theme', theme);
}
