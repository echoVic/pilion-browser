import { randomUUID } from 'node:crypto';
import { AgentTransportError } from './errors.js';
import type { AgentLaunchConfig, TrustedAgentConfig } from './types.js';

const issued = new WeakSet<object>();

function validate(config: AgentLaunchConfig): void {
  if (!config.id.trim() || !config.command.trim() || config.command.includes('\0')) {
    throw new AgentTransportError('UNTRUSTED_CONFIG', 'Agent id and executable must be non-empty and contain no NUL');
  }
  for (const value of config.args ?? []) {
    if (value.includes('\0')) throw new AgentTransportError('UNTRUSTED_CONFIG', 'Agent argument contains NUL');
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) {
      throw new AgentTransportError('UNTRUSTED_CONFIG', 'Agent environment is invalid', { key });
    }
  }
}

/** A process-local authority. Persist launch data separately and re-approve it on each app start. */
export class AgentTrustStore {
  #records = new Map<string, TrustedAgentConfig>();

  approve(config: AgentLaunchConfig): TrustedAgentConfig {
    validate(config);
    const trusted = Object.freeze({
      id: config.id,
      command: config.command,
      args: Object.freeze([...(config.args ?? [])]),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: Object.freeze({ ...config.env }) } : {}),
      trustId: randomUUID(),
    });
    issued.add(trusted);
    this.#records.set(trusted.trustId, trusted);
    return trusted;
  }

  revoke(trustId: string): void {
    this.#records.delete(trustId);
  }

  assert(config: TrustedAgentConfig): void {
    if (!issued.has(config) || this.#records.get(config.trustId) !== config) {
      throw new AgentTransportError('UNTRUSTED_CONFIG', 'Agent configuration was not issued by this process');
    }
  }
}
