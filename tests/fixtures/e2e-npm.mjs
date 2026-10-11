#!/usr/bin/env node
/* global process, Buffer, setInterval, clearInterval */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const cache = args[args.indexOf('--cache') + 1];
if (!args.includes('--prefix') || !args.includes('--cache')) process.exit(1);
const spec = args.at(-1);
const separator = spec.lastIndexOf('@');
const name = spec.slice(0, separator);
const version = spec.slice(separator + 1);
const tmp = path.join(cache, '_cacache', 'tmp');
const content = path.join(cache, '_cacache', 'content-v2', 'sha512');
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(content, { recursive: true });
const download = path.join(tmp, 'in-flight');
fs.writeFileSync(download, Buffer.alloc(1_000_000));
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  fs.appendFileSync(download, Buffer.alloc(500_000));
  fs.writeFileSync(path.join(content, `chunk-${ticks}`), Buffer.alloc(500_000));
  if (ticks < 6) return;
  clearInterval(timer);
  const root = path.join(prefix, 'node_modules', name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name, version, bin: { 'claude-agent-acp': 'cli.mjs' } }),
  );
  const fixture = pathToFileURL(path.join(import.meta.dirname, 'e2e-agent.mjs')).href;
  fs.writeFileSync(
    path.join(root, 'cli.mjs'),
    `#!/usr/bin/env node\nimport ${JSON.stringify(fixture)};\n`,
    { mode: 0o755 },
  );
  const bin = path.join(prefix, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join('..', name, 'cli.mjs'), path.join(bin, 'claude-agent-acp'));
  fs.writeFileSync(
    path.join(prefix, 'package.json'),
    JSON.stringify({ dependencies: { [name]: version } }),
  );
}, 1000);
