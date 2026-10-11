import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/retry-on-network-error.mjs', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function run(message: string, succeedsAfter = Infinity, attempts = 3, padding = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'pilion-retry-'));
  directories.push(directory);
  const counter = join(directory, 'attempts');
  const command = `
    const fs = require('node:fs');
    const file = process.argv[1];
    const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
    fs.writeFileSync(file, String(count));
    console.log('running ' + count);
    if (count <= ${succeedsAfter}) {
      fs.writeSync(2, ${JSON.stringify(message)} + '\\n');
      if (${padding} > 0) {
        fs.writeSync(2, 'x'.repeat(${padding}));
        fs.writeSync(2, '\\nETIMEDOUT\\n');
      }
      process.exit(17);
    }
  `;
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--attempts',
      String(attempts),
      '--delay-ms',
      '0',
      '--',
      process.execPath,
      '-e',
      command,
      counter,
      'argument-secret',
    ],
    { encoding: 'utf8', env: { ...process.env, CSC_KEY_PASSWORD: 'environment-secret' } },
  );
  return { ...result, count: () => Number(readFileSync(counter, 'utf8')) };
}

describe('packaging network retry', () => {
  it('retries a transient failure once and passes both output streams through', () => {
    const result = run('The Internet connection appears to be offline', 1);
    expect(result.status).toBe(0);
    expect(result.count()).toBe(2);
    expect(result.stdout).toContain('running 1\nrunning 2');
    expect(result.stderr).toContain('The Internet connection appears to be offline');
    expect(result.stderr).toContain('attempt 2/3');
    expect(result.stdout + result.stderr).not.toMatch(/argument-secret|environment-secret/);
  });

  it.each([
    'Invalid',
    'The signature of the binary is invalid',
    'notarytool: status: Invalid\nNSURLErrorDomain',
    'HTTP 503 from an unrelated service',
  ])('does not retry a permanent failure: %s', (message) => {
    const result = run(message);
    expect(result.status).toBe(17);
    expect(result.count()).toBe(1);
    expect(result.stderr).not.toContain('attempt');
  });

  it('never forgets a notarization rejection when later logs exceed the output tail', () => {
    const result = run('notarytool: status: Invalid', Infinity, 2, 70_000);
    expect(result.status).toBe(17);
    expect(result.count()).toBe(1);
    expect(result.stderr).not.toContain('attempt');
  });

  it('does not treat an earlier successful GitHub operation as the source of an unrelated HTTP error', () => {
    const result = run('published to GitHub successfully\nHTTP 503 from an unrelated service');
    expect(result.status).toBe(17);
    expect(result.count()).toBe(1);
    expect(result.stderr).not.toContain('attempt');
  });

  it.each([
    'The network connection was lost',
    'NSURLErrorDomain Code=-1009',
    'The request timed out',
    'Request timed out',
    'A server with the specified hostname could not be found',
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    'socket hang up',
    'notarytool: HTTP 502 Bad Gateway',
    'HttpError: 503 Service Unavailable\nhttps://api.github.com/repos/echoVic/pilion-browser/releases',
    'GitHub: HTTP 504 Gateway Timeout',
  ])('stops a transient failure at the attempt limit: %s', (message) => {
    const result = run(message, Infinity, 2);
    expect(result.status).toBe(17);
    expect(result.count()).toBe(2);
    expect(result.stderr).toContain('attempt 2/2');
    expect(result.stderr).not.toContain('attempt 3');
  });
});
