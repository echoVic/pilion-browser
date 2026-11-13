import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentConfigs, saveAgentConfigs } from '../src/main/agent-config-store';
import type { AgentConfig } from '../src/shared/contracts';

let dir: string;
let path: string;
const agent = (id: string): AgentConfig => ({
  id,
  name: `Agent ${id}`,
  command: 'node',
  args: ['--acp'],
  enabled: true,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pilion-agents-'));
  path = join(dir, 'agents.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('agent config store', () => {
  it('a missing file is simply no agents', async () => {
    expect(await loadAgentConfigs(path)).toEqual({ agents: [], unreadable: 0 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('round-trips, writes 0600 and leaves no temporary file behind', async () => {
    await saveAgentConfigs(path, [agent('a'), agent('b')]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['agents.json']);
    const loaded = await loadAgentConfigs(path);
    expect(loaded.unreadable).toBe(0);
    expect(loaded.agents.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('one unreadable entry is skipped on its own; the rest load and the original is kept', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = JSON.stringify([agent('a'), { id: 'broken' }, agent('c')]);
    await writeFile(path, original);
    const loaded = await loadAgentConfigs(path);
    expect(loaded.agents.map((item) => item.id)).toEqual(['a', 'c']);
    expect(loaded.unreadable).toBe(1);
    // 之后的保存不会再带上跳过的那条：原件先留一份。
    expect(await readFile(`${path}.unreadable`, 'utf8')).toBe(original);
    await saveAgentConfigs(path, loaded.agents);
    expect(await readFile(`${path}.unreadable`, 'utf8')).toBe(original);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('a file that is not a JSON array counts as unreadable and is kept, not silently replaced', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(path, '{ truncated');
    expect(await loadAgentConfigs(path)).toEqual({ agents: [], unreadable: 1 });
    expect(await readFile(`${path}.unreadable`, 'utf8')).toBe('{ truncated');
  });

  it('a failed write leaves the previous file intact and no temporary file', async () => {
    await saveAgentConfigs(path, [agent('a')]);
    const circular: Record<string, unknown> = { ...agent('b') };
    circular.self = circular;
    await expect(saveAgentConfigs(path, [circular as unknown as AgentConfig])).rejects.toThrow();
    expect((await loadAgentConfigs(path)).agents.map((item) => item.id)).toEqual(['a']);
    expect(await readdir(dir)).toEqual(['agents.json']);
  });
});
