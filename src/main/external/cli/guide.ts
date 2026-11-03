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

1. Open a tab and keep its id:
   \`\`\`bash
   pilion new https://example.com          # prints the tab id, e.g. tab-3
   \`\`\`
2. Read the page:
   \`\`\`bash
   pilion read --tab tab-3                 # title, URL and visible text
   pilion info --tab tab-3                 # title, URL, loading state
   \`\`\`
3. Find something to act on:
   \`\`\`bash
   pilion observe --tab tab-3 --json       # interactive elements with elementRef
   \`\`\`
   Each element has a \`ref\` object. Copy it **exactly** into \`--ref\`. Never
   write or edit a ref by hand. A ref goes stale when the page changes:
   observe again after every navigation or action that changes the page.
4. Act:
   \`\`\`bash
   pilion click  --tab tab-3 --ref '<ref json>'
   pilion type   --tab tab-3 --ref '<ref json>' --text 'hello' [--replace]
   pilion select --tab tab-3 --ref '<ref json>' --value 'option value'
   pilion check  --tab tab-3 --ref '<ref json>' [--off]
   pilion press  Enter --tab tab-3 --ref '<ref json>'
   pilion navigate https://example.com/next --tab tab-3
   \`\`\`
5. Look at it when text is not enough:
   \`\`\`bash
   pilion screenshot --tab tab-3 -o "$TMPDIR/pilion-shot.png"
   \`\`\`
6. When the task is done, close your tabs: \`pilion close tab-3\`.

Always pass \`--tab\`. Without it Pilion picks the first tab you opened, which
is rarely what you mean once you have more than one.

Add \`--json\` to any command for machine-readable output. Errors are printed
as \`{"error": "..."}\` on stdout with \`--json\`, otherwise on stderr, and the
exit code is 1.

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
