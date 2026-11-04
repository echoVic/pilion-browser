import { PressKeySchema } from '../../../shared/contracts.js';

/** `pilion skill` 打印的用法指南。随 App 版本发布；SKILL.md 只负责引导 Agent 来读它。 */
export const GUIDE_SENTINEL = '[pilion:skill] end of guide';

export function renderGuide(version: string): string {
  return `# Pilion browser — usage guide (pilion ${version})

Pilion is the person's own desktop browser. You drive it through the \`pilion\`
command. Every command goes through Pilion's trust layer:

- Actions that change a page (navigate, click, type, select, check, press) may
  wait for the person to approve them in Pilion's window. The command blocks
  until they answer, for up to 90 seconds. If it times out, tell the person to
  look at Pilion and approve, then retry once.
- You can only see and touch tabs you opened yourself with \`pilion new\`, plus
  tabs the person explicitly shared. You never see the tab the person is on.
- There is no way to run JavaScript in the page. Do not try to work around it.

## Workflow

### Space（Agent 工作区）

每个使用 Pilion 的对话都应有自己的 Space，避免不同对话的标签混在一起。

1 为当前对话创建 Space，保存返回的 id：
   \`\`\`bash
   SPACE=$(pilion space new "任务描述")   # 输出 spaceId，例如 agent-<uuid>
   \`\`\`
2 在 Space 内打开标签，保存标签 id：
   \`\`\`bash
   TAB=$(pilion new https://example.com --space "$SPACE")
   \`\`\`
3 读取和操作时，始终传入 --space 和 --tab：
   \`\`\`bash
   pilion read    --space "$SPACE" --tab "$TAB"
   pilion observe --space "$SPACE" --tab "$TAB" --json
   pilion click   --space "$SPACE" --tab "$TAB" --ref '<ref json>'
   \`\`\`
   每个元素都有 \`ref\` 对象。将它**原样复制**到 \`--ref\`，不要手写或修改。
   导航或操作改变页面后，重新 observe 获取新 ref。
4 任务完成后关闭 Space：
   \`\`\`bash
   pilion space close "$SPACE"
   \`\`\`

集成客户端省略 \`--space\` 时，命令会报错并提示正确用法。
任务中的每条浏览器命令都传 \`--space "$SPACE"\`，也可以设置
\`export PILION_SPACE="$SPACE"\`。skill、status、version 和 space 命令不需要 Space。
Pilion 重启后 Space 可恢复使用；用户已停止或接管的 Space 不能恢复。
如果命令报「Space 已结束」：

- 查看用户是否在 Pilion 侧栏停止或接管了 Space。
- 不要静默重试或新建。告诉用户发生了什么，等待用户同意后再新建 Space。

Always pass \`--tab\`. Without it Pilion picks the first tab you opened, which
is rarely what you mean once you have more than one.

Add \`--json\` to any command for machine-readable output. Errors are printed
as \`{"error": "..."}\` on stdout with \`--json\`, otherwise on stderr, and the
exit code is 1

## Commands

| Command | Does |
| --- | --- |
| \`pilion tabs\` | List your tabs |
| \`pilion new <url>\` | Open a tab, print its id |
| \`pilion activate <id>\` / \`pilion close <id>\` | Show / close a tab |
| \`pilion navigate <url> --tab <id>\` | Go to a URL |
| \`pilion read --tab <id>\` | Title, URL, visible text |
| \`pilion info --tab <id>\` | Page info |
| \`pilion observe --tab <id>\` | Interactive elements and their refs |
| \`pilion click\` / \`type\` / \`select\` / \`check\` / \`press\` | Act on a ref |
| \`pilion screenshot -o <file.png> --tab <id>\` | PNG screenshot (refuses to overwrite without \`--force\`) |
| \`pilion status\` | Check that Pilion is running and this command is connected |
| \`pilion skill\` | Print this guide |

\`press\` keys: ${PressKeySchema.options.join(', ')}.

## When something fails

- **Space 已结束 / SPACE_ENDED**：用户停止或接管了 Space，或 Space 已空闲
  60 分钟。不要静默重建；告诉用户，等待用户同意后再新建 Space。
- **SPACE_REQUIRED**：忘了传 --space。先运行 \`pilion space new "<任务名>"\`，
  再给每条浏览器命令加 \`--space <id>\`。
- **SPACE_LIMIT**：已有 8 个活跃 Space。运行 \`pilion space list\` 查看，
  再用 \`pilion space close <id>\` 结束一个，或请用户在 Pilion 侧栏结束一个。
- **Denied / 已拒绝**: the person said no. Do not retry the same action; ask
  them what they want instead.
- **Permission denied on a tab**: it is not your tab. Open your own with
  \`pilion new\`.
- **Stale or unknown element**: run \`pilion observe\` again and use a fresh ref.
- **Sign-in, captcha, payment**: stop and ask the person to do that step in
  Pilion, then continue when they say so.
- **Cannot connect / credential errors**: run \`pilion status\` and follow it.

${GUIDE_SENTINEL} (pilion ${version})`;
}
