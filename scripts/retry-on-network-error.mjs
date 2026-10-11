/* global process */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout } from 'node:timers/promises';

// 只重试网络故障；签名或公证拒绝即使夹着网络报错，也不能重试。
const TRANSIENT_ERRORS = [
  /The Internet connection appears to be offline/i,
  /The network connection was lost/i,
  /NSURLErrorDomain/,
  /\b(?:The )?request timed out/i,
  /A server with the specified hostname could not be found/i,
  /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/,
  /socket hang up/i,
];
const HTTP_ERROR =
  /\b(?:HTTP(?:Error)?(?:\/\d(?:\.\d)?)?\s*[:=]?\s*|status(?:\s+code)?\s*[:=]?\s*)50[234]\b/i;
const HTTP_SERVICE = /notarytool|\bgithub\b|(?:api|uploads)\.github\.com/i;
const HTTP_REQUEST_URL = /https:\/\/(?:(?:api|uploads)\.)?github\.com\b/i;
const REJECTION =
  /\bInvalid\b|signature.*(?:invalid|rejected)|notari[sz]ation.*(?:rejected|failed validation)/i;
const TAIL_LENGTH = 64 * 1024;

function transient(output) {
  if (REJECTION.test(output)) return false;
  const lines = output.split(/\r?\n/);
  return (
    TRANSIENT_ERRORS.some((pattern) => pattern.test(output)) ||
    lines.some(
      (line, index) =>
        HTTP_ERROR.test(line) &&
        (HTTP_SERVICE.test(line) || HTTP_REQUEST_URL.test(lines[index + 1] ?? '')),
    )
  );
}

function options(argv) {
  let attempts = 3;
  let delayMs = 30_000;
  let index = 0;
  while (index < argv.length && argv[index] !== '--') {
    const flag = argv[index++];
    const value = Number(argv[index++]);
    if (!Number.isSafeInteger(value) || value < (flag === '--attempts' ? 1 : 0)) return;
    if (flag === '--attempts') attempts = value;
    else if (flag === '--delay-ms' && value <= 2_147_483_647) delayMs = value;
    else return;
  }
  if (argv[index] !== '--' || !argv[index + 1]) return;
  return { attempts, delayMs, command: argv[index + 1], args: argv.slice(index + 2) };
}

function run(command, args) {
  return new Promise((resolve) => {
    let tail = '';
    let rejected = false;
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    const pass = (stream) => (chunk) => {
      stream.write(chunk);
      const output = tail + chunk.toString();
      // 拒绝不能被后续日志挤出 tail 后遗忘，也不能漏掉跨 chunk 的报错。
      rejected ||= REJECTION.test(output);
      tail = output.slice(-TAIL_LENGTH);
    };
    child.stdout.on('data', pass(process.stdout));
    child.stderr.on('data', pass(process.stderr));
    child.on('error', () => {
      // 不打印命令、参数或环境：里面可能有发布凭证。
      process.stderr.write('无法启动打包命令。\n');
    });
    child.on('close', (code, signal) =>
      resolve({
        code: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1),
        retry: code !== null && !rejected && transient(tail),
      }),
    );
  });
}

const parsed = options(process.argv.slice(2));
if (!parsed) {
  process.stderr.write(
    '用法：node scripts/retry-on-network-error.mjs [--attempts 3] [--delay-ms 30000] -- <command> [args...]\n',
  );
  process.exitCode = 2;
} else {
  for (let attempt = 1; attempt <= parsed.attempts; attempt++) {
    const result = await run(parsed.command, parsed.args);
    process.exitCode = result.code;
    if (result.code === 0 || !result.retry || attempt === parsed.attempts) break;
    process.stderr.write(
      `网络暂时不可用，正在重试（attempt ${attempt + 1}/${parsed.attempts}）。\n`,
    );
    await setTimeout(parsed.delayMs);
  }
}
