/**
 * Markdown 外链只放行 http(s)，其余协议不动作；打开一律交受控浏览器（window.pilion.tabs.open）。
 * 抽出纯函数便于单测：ChatMessage 不渲染原始 HTML，外链由受控浏览器打开。
 */
export function safeExternalHref(href: string | undefined): string | undefined {
  if (href && /^https?:\/\//i.test(href)) return href;
  return undefined;
}

/** 把消息自带的 ISO 时间格式化成 HH:MM（与设计稿消息时间一致）。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
