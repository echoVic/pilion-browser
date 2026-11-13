/**
 * 地址里的凭据不进日志。登录回调的 code、重置密码链接的 token、预签名下载地址的签名，都明文挂在
 * 查询串或片段里；录下来就会躺在 events.jsonl、trajectory.md 里，还会经提炼交给 Agent。
 *
 * 只换值、不动别的：参数名留着（人和 Agent 看得出这里原来有什么），其余参数逐字节不变，片段也留着
 * （锚点与 #/ 路由要能回放）。片段里也按「名=值」处理：#/callback?code=… 抹 ? 后面的那段，
 * 隐式授权的 #access_token=… 整段当参数抹。路径里的凭据、片段里不带名字的裸令牌认不出来，照原样留下。
 */

/** 换上去的值。回放认它：名字是凭据、值是它的参数，说明原值没有录下，那次导航交给人。 */
export const REDACTED = 'REDACTED';

/** 地址里凭据被抹掉的导航交给人时说的话。 */
export const URL_REDACTED_REASON =
  '手动打开录制时的那个页面：录下的地址里去掉了敏感信息，回放无法原样打开';

const SECRET_NAMES = new Set([
  'code',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'key',
  'apikey',
  'api_key',
  'api-key',
  'secret',
  'password',
  'passwd',
  'pwd',
  'signature',
  'sig',
  'session',
  'sessionid',
  'sid',
  'auth',
  'ticket',
  'otp',
]);
/** 以这些结尾的名字也算：accessToken、auth_token、client_secret、X-Amz-Signature 之类。 */
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'signature'];

function paramName(raw: string): string {
  const plus = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus).trim().toLowerCase();
  } catch {
    return plus.trim().toLowerCase();
  }
}

function isSecretName(raw: string): boolean {
  const name = paramName(raw);
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** 「a=1&b=2」这样的一段：凭据参数的值换成 REDACTED，其余原样拼回去。 */
function redactParams(params: string): string {
  return params
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals < 0 || equals === pair.length - 1) return pair;
      return isSecretName(pair.slice(0, equals)) ? `${pair.slice(0, equals + 1)}${REDACTED}` : pair;
    })
    .join('&');
}

function redactFragment(fragment: string): string {
  const question = fragment.indexOf('?');
  if (question >= 0)
    return `${fragment.slice(0, question + 1)}${redactParams(fragment.slice(question + 1))}`;
  return fragment.includes('=') ? redactParams(fragment) : fragment;
}

/** 字符串层面替换，不经 URL 解析再序列化：没有凭据的地址一个字节都不变。 */
export function redactUrl(url: string): string {
  const hash = url.indexOf('#');
  const beforeHash = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? undefined : url.slice(hash + 1);
  const question = beforeHash.indexOf('?');
  const base = question < 0 ? beforeHash : beforeHash.slice(0, question + 1);
  const query = question < 0 ? '' : redactParams(beforeHash.slice(question + 1));
  return `${base}${query}${fragment === undefined ? '' : `#${redactFragment(fragment)}`}`;
}

function hasRedactedParam(params: string): boolean {
  return params.split('&').some((pair) => {
    const equals = pair.indexOf('=');
    return equals > 0 && pair.slice(equals + 1) === REDACTED && isSecretName(pair.slice(0, equals));
  });
}

/** 这个地址里有被抹掉的凭据：照着它导航只会带着「REDACTED」去敲门。 */
export function hasRedactedSecret(url: string): boolean {
  const hash = url.indexOf('#');
  const beforeHash = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? '' : url.slice(hash + 1);
  const question = beforeHash.indexOf('?');
  const fragmentQuestion = fragment.indexOf('?');
  return (
    (question >= 0 && hasRedactedParam(beforeHash.slice(question + 1))) ||
    hasRedactedParam(fragmentQuestion >= 0 ? fragment.slice(fragmentQuestion + 1) : fragment)
  );
}
