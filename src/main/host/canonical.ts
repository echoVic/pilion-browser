import { createHash } from 'node:crypto';
import type { EffectLevel } from './types.js';

export interface TargetBinding {
  origin: string;
  tenantId?: string;
  documentEpoch?: string;
  frameId?: string;
  frameEpoch?: number;
  elementRef?: string;
  localFingerprint?: string;
}

export interface CanonicalCommandV1 {
  schemaVersion: '1';
  tool: { name: string; version: string };
  arguments: Record<string, unknown>;
  profileId: string;
  sessionId: string;
  tabId: string;
  target: TargetBinding;
  effect: EffectLevel;
  dataFlow: {
    source: string;
    destination: string;
    classifications: string[];
  };
  obligations: Array<{ type: string; parameters: Record<string, unknown> }>;
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical values must contain finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = normalize(item);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

export function canonicalEncode(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function cborHead(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('CBOR length/integer is out of range');
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value <= 0xff) return Buffer.from([(major << 5) | 24, value]);
  if (value <= 0xffff) {
    const result = Buffer.alloc(3);
    result[0] = (major << 5) | 25;
    result.writeUInt16BE(value, 1);
    return result;
  }
  if (value <= 0xffffffff) {
    const result = Buffer.alloc(5);
    result[0] = (major << 5) | 26;
    result.writeUInt32BE(value, 1);
    return result;
  }
  const result = Buffer.alloc(9);
  result[0] = (major << 5) | 27;
  result.writeBigUInt64BE(BigInt(value), 1);
  return result;
}

/** RFC 8949 deterministic encoding for the JSON-compatible Host DTO subset. */
export function canonicalCborEncode(value: unknown): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical values must contain finite numbers');
    const number = Object.is(value, -0) ? 0 : value;
    if (Number.isSafeInteger(number))
      return cborHead(number >= 0 ? 0 : 1, number >= 0 ? number : -1 - number);
    const result = Buffer.alloc(9);
    result[0] = 0xfb;
    result.writeDoubleBE(number, 1);
    return result;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(canonicalCborEncode)]);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => ({ key: canonicalCborEncode(key), value: canonicalCborEncode(item) }))
      .sort((a, b) => a.key.length - b.key.length || Buffer.compare(a.key, b.key));
    return Buffer.concat([
      cborHead(5, entries.length),
      ...entries.flatMap((entry) => [entry.key, entry.value]),
    ]);
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalEncode(value)).digest('hex');
}

export function canonicalizeCommand(input: CanonicalCommandV1): CanonicalCommandV1 {
  const command = normalize(input) as CanonicalCommandV1;
  if (command.schemaVersion !== '1' || !command.tool.name || !command.tool.version) {
    throw new TypeError('Invalid canonical command schema');
  }
  const parsedOrigin = new URL(command.target.origin);
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new TypeError('Canonical target origin must be HTTP(S)');
  }
  command.target.origin = parsedOrigin.origin;
  command.dataFlow.classifications = [...new Set(command.dataFlow.classifications)].sort();
  command.obligations = [...command.obligations].sort((a, b) =>
    canonicalEncode(a).localeCompare(canonicalEncode(b)),
  );
  return command;
}

export function canonicalCommandHash(command: CanonicalCommandV1): string {
  return sha256(canonicalizeCommand(command));
}

export interface ActionDigestBinding {
  command: CanonicalCommandV1;
  policySetVersion: string;
  criticalObligations?: Array<{ type: string; parameters: Record<string, unknown> }>;
}

export function actionDigest(binding: ActionDigestBinding): string {
  const command = canonicalizeCommand(binding.command);
  return sha256({
    schemaVersion: '1',
    command,
    policySetVersion: binding.policySetVersion,
    criticalObligations: binding.criticalObligations ?? command.obligations,
  });
}
