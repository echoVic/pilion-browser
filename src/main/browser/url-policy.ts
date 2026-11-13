import { BrowserError } from './errors.js';

/**
 * "example.com:8080" is a host and a port to everyone typing in an address bar, but it also
 * matches the shape of a scheme. Anything whose colon is followed only by a port number is
 * therefore read as a host, which keeps "javascript:alert(1)" and "data:…" on the scheme path.
 */
function hasScheme(input: string): boolean {
  if (/^[a-z][a-z\d.+-]*:\d+(?:[/?#]|$)/i.test(input)) return false;
  return /^[a-z][a-z\d+.-]*:/i.test(input);
}

export async function canonicalizeUrl(raw: string): Promise<string> {
  const input = raw.trim();
  if (!input) throw new BrowserError('INVALID_ARGUMENT', 'URL is required');
  if (input === 'about:blank') return input;

  let url: URL;
  try {
    url = new URL(hasScheme(input) ? input : `https://${input}`);
  } catch {
    throw new BrowserError('INVALID_ARGUMENT', 'URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('DANGEROUS_URL', `Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new BrowserError('DANGEROUS_URL', 'Credentials in URLs are not allowed');
  }
  if (!url.hostname) throw new BrowserError('INVALID_ARGUMENT', 'URL hostname is required');

  // The fragment stays: it is the page's own route or anchor ("/#/inbox", a heading) and never
  // reaches the server. Anything that asks "is this the same document" strips it itself, the way
  // navigationKey in the page adapter does.
  // Let Chromium own DNS, proxy selection and local-network reachability. Pilion still
  // rejects non-web protocols and credentials, but it does not classify destinations by IP.
  return url.toString();
}

/**
 * URL 策略错误的英文原文是给 MCP agent 看的；用户从地址栏、书签等入口触发导航被拦时，
 * 在用户入口边界换成中文人话。识别不了的错误返回 undefined，由调用方回退到原文。
 */
export function describePolicyError(error: unknown): string | undefined {
  if (!(error instanceof BrowserError)) return undefined;
  switch (error.code) {
    case 'DANGEROUS_URL':
      if (error.message.includes('Credentials')) return '网址中不能包含用户名或密码。';
      return '仅支持打开 http:// 或 https:// 开头的网页地址。';
    case 'INVALID_ARGUMENT':
      return '网址无效，请检查输入的地址后重试。';
    default:
      return undefined;
  }
}
