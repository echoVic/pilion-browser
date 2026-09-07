export const LOCAL_AGENT_IDS = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'opencode',
  'pi',
] as const;
export type LocalAgentPreset = (typeof LOCAL_AGENT_IDS)[number];
export interface LocalAgentDefinition {
  id: LocalAgentPreset;
  name: string;
  executable: string;
  aliases: readonly string[];
  cli: string;
  package?: string;
  args: readonly string[];
  authEnv: readonly string[];
  requiredPackageName?: string;
  minNode?: readonly [number, number, number];
}
export const LOCAL_AGENTS: readonly LocalAgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    executable: 'claude-agent-acp',
    aliases: ['claude-code-acp'],
    cli: 'claude',
    package: '@agentclientprotocol/claude-agent-acp@0.75.1',
    args: [],
    authEnv: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    executable: 'codex-acp',
    aliases: [],
    cli: 'codex',
    package: '@agentclientprotocol/codex-acp@1.10.0',
    args: [],
    authEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    executable: 'gemini',
    aliases: [],
    cli: 'gemini',
    package: '@google/gemini-cli@0.58.0',
    args: ['--experimental-acp'],
    authEnv: [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
    ],
  },
  {
    id: 'grok',
    name: 'Grok Build',
    executable: 'grok',
    aliases: [],
    cli: 'grok',
    args: ['agent', '--no-leader', 'stdio'],
    authEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    executable: 'opencode',
    aliases: [],
    cli: 'opencode',
    package: 'opencode-ai@1.18.29',
    args: ['acp'],
    authEnv: [
      'OPENCODE_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'XAI_API_KEY',
      'OPENROUTER_API_KEY',
    ],
  },
  {
    id: 'pi',
    name: 'Pi',
    executable: 'pi-acp',
    aliases: [],
    cli: 'pi',
    package: '@automatalabs/pi-acp@0.6.3',
    requiredPackageName: '@automatalabs/pi-acp',
    minNode: [22, 19, 0],
    args: [],
    authEnv: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'XAI_API_KEY',
      'OPENROUTER_API_KEY',
    ],
  },
];

export interface LocalAgentInput {
  preset: LocalAgentPreset;
  nodePath?: string;
  cwd?: string;
}
export interface LocalAgentEnvironment {
  nodePath?: string;
  nodeVersion?: string;
  error?: string;
  defaultCwd: string;
  agents: {
    id: LocalAgentPreset;
    executablePath?: string;
    cliPath?: string;
    error?: string;
    status: 'ready' | 'install_required' | 'runtime_missing' | 'cli_missing';
  }[];
}
