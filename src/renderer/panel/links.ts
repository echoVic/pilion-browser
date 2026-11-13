/**
 * Markdown 外链只放行 http(s)，其余协议不动作；打开一律交受控浏览器（window.pilion.tabs.open）。
 * 抽出纯函数便于单测：ChatMessage 不渲染原始 HTML，外链由受控浏览器打开。
 */
export function safeExternalHref(href: string | undefined): string | undefined {
  if (href && /^https?:\/\//i.test(href)) return href;
  return undefined;
}

/**
 * 点了会交给系统默认程序打开的扩展名。必须与主进程 src/main/local-file.ts 的
 * OPENABLE_EXTENSIONS 保持一致：真正决定打开还是定位的是主进程，这里只决定按钮怎么说。
 */
export const OPENABLE_FILE_EXTENSIONS = [
  'md',
  'markdown',
  'txt',
  'log',
  'json',
  'csv',
  'tsv',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'yaml',
  'yml',
  'toml',
  'docx',
  'xlsx',
  'pptx',
] as const;

/**
 * 只在文件夹里定位、从不打开的扩展名：它们默认由浏览器打开，能带脚本跑起来。
 * 必须与 src/main/local-file.ts 保持一致：那边正是把这几种排除在 OPENABLE_EXTENSIONS 之外。
 */
export const REVEAL_ONLY_FILE_EXTENSIONS = ['html', 'htm', 'svg', 'xml'] as const;

const OPENABLE = new Set<string>(OPENABLE_FILE_EXTENSIONS);

/** 可以当作文件链接渲染的扩展名：文档、图片与纯文本，不含任何可执行类型。 */
const LOCAL_FILE_PATTERN = new RegExp(
  `\\.(?:${[...OPENABLE_FILE_EXTENSIONS, ...REVEAL_ONLY_FILE_EXTENSIONS].join('|')})$`,
  'i',
);

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

/**
 * 主进程拿到这个链接会打开还是只定位，规则与 src/main/local-file.ts 的 localFileAction 相同：
 * 扩展名可打开才打开，其余（html/htm/svg/xml、没有扩展名的、别的类型）一律只定位。
 * file:// 的查询串和锚点不属于路径，先去掉；普通路径主进程原样使用，这里也不动。
 */
export function localFileAction(href: string): 'open' | 'reveal' {
  const trimmed = href.trim();
  const path = /^file:\/\//i.test(trimmed) ? trimmed.replace(/[?#].*$/, '') : trimmed;
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'reveal';
  return OPENABLE.has(name.slice(dot + 1).toLowerCase()) ? 'open' : 'reveal';
}

/** 「在 Finder 中显示」只是 macOS 的说法；其它系统叫文件夹。 */
export function revealLabel(userAgent: string): string {
  return userAgent.includes('Macintosh') ? '在 Finder 中显示' : '在文件夹中显示';
}

/** 文件链接的悬停说明：说清这一下是打开，还是只在文件夹里找到它。 */
export function localFileTitle(href: string, userAgent: string): string {
  return localFileAction(href) === 'open' ? `打开 ${href}` : `${revealLabel(userAgent)} ${href}`;
}

/** 把消息自带的 ISO 时间格式化成 HH:MM（与设计稿消息时间一致）。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
