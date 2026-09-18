import type { ButtonHTMLAttributes } from 'react';

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
/** The Pilion mark: a lowercase p whose bowl is an orbit, with the satellite nested in the ring's gap. */
export function PilionMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.4 20.5V9.6a5.6 5.6 0 0 1 7.8-5.15" />
      <path d="M18.6 9.6A5.6 5.6 0 0 1 7.4 9.6" />
      <circle cx="13" cy="9.6" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="5.9" r="1.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <PilionMark size={compact ? 19 : 30} />
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
