/**
 * Markdown 外链只放行 http(s)，其余协议不动作；打开一律交受控浏览器（window.pilion.tabs.open）。
 * 抽出纯函数便于单测：ChatMessage 不渲染原始 HTML，外链由受控浏览器打开。
 */
export function safeExternalHref(href: string | undefined): string | undefined {
  if (href && /^https?:\/\//i.test(href)) return href;
  return undefined;
}

/** 可以当作文件链接渲染的扩展名：文档、图片与纯文本，不含任何可执行类型。 */
const LOCAL_FILE_PATTERN =
  /\.(?:md|markdown|txt|log|json|csv|tsv|pdf|png|jpe?g|gif|webp|svg|html?|xml|ya?ml|toml|docx|xlsx|pptx)$/i;

/**
 * 消息里指向本地文件的 href（`file://`、绝对路径、`./相对路径`、裸文件名）。
 * 这类链接不再渲染成"点了没反应"的按钮，而是交给主进程按安全策略打开/定位。
 */
export function localFileHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (/^https?:\/\//i.test(href)) return undefined;
  if (/^file:\/\//i.test(href)) return href;
  // 其它协议（javascript:、mailto:、data: …）一律不当作文件。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  if (href.startsWith('#')) return undefined;
  const withoutFragment = href.split('#')[0]!.split('?')[0]!;
  return LOCAL_FILE_PATTERN.test(withoutFragment) ? href : undefined;
}

/** 把消息自带的 ISO 时间格式化成 HH:MM（与设计稿消息时间一致）。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
