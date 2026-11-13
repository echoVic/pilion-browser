import { expect, it } from 'vitest';
import { localFileAction as mainLocalFileAction } from '../src/main/local-file';
import {
  formatClock,
  localFileAction,
  localFileHref,
  localFileTitle,
  OPENABLE_FILE_EXTENSIONS,
  REVEAL_ONLY_FILE_EXTENSIONS,
  safeExternalHref,
} from '../src/renderer/panel/links';

it('safeExternalHref 只放行 http(s)', () => {
  expect(safeExternalHref('https://example.com/x')).toBe('https://example.com/x');
  expect(safeExternalHref('http://localhost:3000')).toBe('http://localhost:3000');
  expect(safeExternalHref('HTTPS://Example.COM/x')).toBe('HTTPS://Example.COM/x');
  expect(safeExternalHref('ftp://example.com')).toBeUndefined();
  expect(safeExternalHref('javascript:alert(1)')).toBeUndefined();
  expect(safeExternalHref('mailto:a@b.c')).toBeUndefined();
  expect(safeExternalHref('/relative/path')).toBeUndefined();
  expect(safeExternalHref(undefined)).toBeUndefined();
});

it('formatClock 输出 HH:MM', () => {
  expect(formatClock('2026-10-14T14:05:00+08:00')).toMatch(/^\d{2}:\d{2}$/);
  expect(formatClock('not-a-date')).toBe('');
});

it('localFileHref 只接受可安全打开的本地文件链接', () => {
  expect(localFileHref('telegram-ai-relay-market-2026-11-07.md')).toBe(
    'telegram-ai-relay-market-2026-11-07.md',
  );
  expect(localFileHref('./reports/weekly.md')).toBe('./reports/weekly.md');
  expect(localFileHref('/Users/me/report.pdf')).toBe('/Users/me/report.pdf');
  expect(localFileHref('file:///Users/me/report.md')).toBe('file:///Users/me/report.md');
  expect(localFileHref('notes.txt#L10')).toBe('notes.txt#L10');
  // 网页、其它协议、锚点、没有扩展名的路径都不当本地文件。
  expect(localFileHref('https://example.com/a.md')).toBeUndefined();
  expect(localFileHref('javascript:alert(1)')).toBeUndefined();
  expect(localFileHref('mailto:a@b.c')).toBeUndefined();
  expect(localFileHref('#section')).toBeUndefined();
  expect(localFileHref('/usr/local/bin/tool')).toBeUndefined();
  expect(localFileHref(undefined)).toBeUndefined();
});

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

it('文件链接的悬停说明：html/htm/svg/xml 只定位，其余可打开的写「打开」', () => {
  expect(localFileTitle('./out/report.html', WINDOWS)).toBe('在文件夹中显示 ./out/report.html');
  expect(localFileTitle('page.HTM', WINDOWS)).toBe('在文件夹中显示 page.HTM');
  expect(localFileTitle('/tmp/chart.svg', WINDOWS)).toBe('在文件夹中显示 /tmp/chart.svg');
  expect(localFileTitle('file:///tmp/feed.xml#top', WINDOWS)).toBe(
    '在文件夹中显示 file:///tmp/feed.xml#top',
  );
  // macOS 上和技能库一样叫访达。
  expect(localFileTitle('/tmp/chart.svg', MAC)).toBe('在 Finder 中显示 /tmp/chart.svg');
  expect(localFileTitle('./reports/weekly.md', MAC)).toBe('打开 ./reports/weekly.md');
  expect(localFileTitle('file:///Users/me/a%20b.pdf', WINDOWS)).toBe(
    '打开 file:///Users/me/a%20b.pdf',
  );
});

it('打开还是定位与主进程 src/main/local-file.ts 判得一样：两边的扩展名清单要一起改', () => {
  const extensions = [
    ...OPENABLE_FILE_EXTENSIONS,
    ...REVEAL_ONLY_FILE_EXTENSIONS,
    // 消息里的 file:// 链接可以指向任何类型；可执行的一律只定位。
    'sh',
    'command',
    'app',
    'exe',
    'js',
  ];
  for (const extension of extensions) {
    for (const path of [`/tmp/x.${extension}`, `/tmp/X.${extension.toUpperCase()}`]) {
      expect(localFileAction(path), path).toBe(mainLocalFileAction(path));
    }
  }
  for (const extension of REVEAL_ONLY_FILE_EXTENSIONS)
    expect(mainLocalFileAction(`/tmp/x.${extension}`)).toBe('reveal');
  expect(localFileAction('/usr/local/bin/tool')).toBe(mainLocalFileAction('/usr/local/bin/tool'));
  expect(localFileAction('/tmp/.md')).toBe(mainLocalFileAction('/tmp/.md'));
});
