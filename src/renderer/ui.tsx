import type { ButtonHTMLAttributes } from 'react';
import { Orbit } from 'lucide-react';

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      className={`icon-button ${props.className ?? ''}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Orbit size={compact ? 19 : 30} strokeWidth={1.5} />
      </span>
      {!compact && <span>Pilion</span>}
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
export function addressToUrl(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) return text;
  if (!/\s/.test(text) && text.includes('.')) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
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
