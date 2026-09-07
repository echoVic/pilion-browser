import type { AgentConfig } from '../../shared/contracts.js';
import type { AgentLaunchConfig } from './types.js';

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Command arguments cannot contain NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** SSH carries unmodified ACP stdio and a separate private Unix-socket MCP return path. */
export function sshLaunch(
  config: AgentConfig,
  localSocket: string,
  remoteSocket: string,
): AgentLaunchConfig {
  if (!config.ssh || !/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(config.ssh.host))
    throw new Error('Invalid SSH host');
  if (!config.cwd?.startsWith('/')) throw new Error('远端工作目录必须是绝对路径');
  const env = Object.entries(config.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment variable');
    return shellQuote(`${key}=${value}`);
  });
  const command = `cd ${shellQuote(config.cwd)} && exec env ${env.join(' ')} ${[config.command, ...config.args].map(shellQuote).join(' ')}`;
  return {
    id: config.id,
    command: 'ssh',
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'StreamLocalBindMask=0177',
      '-p',
      String(config.ssh.port),
      ...(config.ssh.identityFile ? ['-i', config.ssh.identityFile] : []),
      '-R',
      `${remoteSocket}:${localSocket}`,
      '--',
      config.ssh.host,
      command,
    ],
  };
}
