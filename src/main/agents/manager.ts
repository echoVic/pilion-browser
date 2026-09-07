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
      if (current === 'closed') this.#connections.delete(transport);
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

  async stopAll(): Promise<void> {
    await Promise.all([...this.#connections].map((connection) => connection.stop()));
  }
}
