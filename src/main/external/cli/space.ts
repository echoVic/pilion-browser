import type { CommandContext } from './commands.js';
import { CliError, printResult } from './output.js';
import type { AgentSpaceSummary } from '../space-protocol.js';

export async function handleSpace(subcommand: string, ctx: CommandContext): Promise<void> {
  const value = ctx.args.rest[0];
  if (subcommand === 'new' && !value) throw new CliError('用法：pilion space new "<任务名>"');
  if (subcommand === 'close' && !value) throw new CliError('用法：pilion space close <spaceId>');
  if (!['new', 'list', 'close'].includes(subcommand)) {
    throw new CliError('用法：pilion space new "<label>" | list | close <id>');
  }
  const getCtrl = ctx.control;
  if (!getCtrl) throw new CliError('space 命令需要凭证；请先运行 pilion status');
  const ctrl = await getCtrl();

  if (subcommand === 'new') {
    const result = (await ctrl({ op: 'space.create', label: value })) as { spaceId: string };
    if (ctx.args.json) {
      ctx.io.stdout(JSON.stringify({ spaceId: result.spaceId }));
    } else {
      ctx.io.stdout(result.spaceId);
      ctx.io.stderr(
        `之后每条命令都加 --space ${result.spaceId}（或 export PILION_SPACE=${result.spaceId}）`,
      );
    }
  } else if (subcommand === 'list') {
    const result = (await ctrl({ op: 'space.list' })) as { spaces: AgentSpaceSummary[] };
    printResult(
      ctx.io,
      ctx.args.json,
      result.spaces,
      result.spaces
        .map((s) => `${s.spaceId}\t${s.state}\t${s.label}${s.endReason ? ` (${s.endReason})` : ''}`)
        .join('\n') || '（无 Agent 空间）',
    );
  } else {
    await ctrl({ op: 'space.close', spaceId: value });
    printResult(ctx.io, ctx.args.json, { ok: true }, '已关闭');
  }
}
