import type { AgentLaunchConfig, TrustedAgentConfig } from './types.js';
import { AgentTransport, type AgentTransportOptions } from './transport.js';
import { AgentTrustStore } from './trust.js';

/** Main-process integration facade. Every connect call creates a new process/stdio transport. */
export class AgentProcessManager {
  readonly trust = new AgentTrustStore();
  #connections = new Set<AgentTransport>();

  approve(config: AgentLaunchConfig): TrustedAgentConfig {
    return this.trust.approve(config);
  }

  async connect(
    config: TrustedAgentConfig,
    options: AgentTransportOptions,
  ): Promise<AgentTransport> {
    const transport = new AgentTransport(this.trust, config, options);
    this.#connections.add(transport);
    transport.on('state', ({ current }) => {
      if (current !== 'closed') return;
      this.#connections.delete(transport);
      // One approval launches one process: once it has ended, its command line and environment
      // (credentials included) are not kept for the rest of the app's life.
      this.trust.revoke(config.trustId);
    });
    try {
      await transport.start();
      return transport;
    } catch (error) {
      const diagnostic = transport.stderrSnapshot.text.trim().slice(-2000);
      await transport.stop();
      if (diagnostic)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${diagnostic}`,
          { cause: error },
        );
      throw error;
    }
  }

  /** Transports still running; for tests and shutdown diagnostics. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#connections].map((connection) => connection.stop()));
  }
}
