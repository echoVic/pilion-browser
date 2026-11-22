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
/** 主流浏览器风格的直立拼图扩展图标（24×24 光学居中，匹配 Lucide 线宽）。 */
export function ExtensionPuzzleIcon({
  size = 15,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 7h2.45a2.3 2.3 0 0 1 4.6 0H15.5A1.5 1.5 0 0 1 17 8.5v2.45a2.3 2.3 0 0 1 0 4.6V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18v-2.45a2.3 2.3 0 0 0 0-4.6V8.5A1.5 1.5 0 0 1 6 7Z" />
    </svg>
  );
}
/** 02 · 几何圆团 P：左圆角立柱（主驾）+ 右上圆球（伴行）+ 右下亮点（焦点）。 */
export function PilionMark({ size = 24, colorful = false }: { size?: number; colorful?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="17 16 68 68" fill="none" aria-hidden="true">
      <rect
        x="23"
        y="21"
        width="20"
        height="58"
        rx="10"
        fill={colorful ? 'var(--brand-cobalt)' : 'currentColor'}
      />
      <circle
        cx="61"
        cy="41"
        r="17.5"
        fill={colorful ? 'var(--brand-coral)' : 'currentColor'}
        fillOpacity={colorful ? 1 : 0.65}
      />
      <circle cx="62" cy="70" r="8.5" fill={colorful ? 'var(--brand-amber)' : 'currentColor'} />
    </svg>
  );
}
/**
 * Pilion 品牌横排组合标：左侧三色几何圆团 P + 右侧清晰无衬线字标，用于新标签页等展示场景。
 */
export function PilionWordmark({ height = 40 }: { height?: number }) {
  return (
    <span className="pilion-wordmark" role="img" aria-label="Pilion">
      <PilionMark size={Math.round(height * 0.84)} colorful />
      <span className="pilion-wordmark-text" style={{ fontSize: Math.round(height * 0.72) }}>
        Pilion
      </span>
    </span>
  );
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      {compact ? (
        <span className="brand-symbol">
          <PilionMark size={19} />
        </span>
      ) : (
        <PilionWordmark />
      )}
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
