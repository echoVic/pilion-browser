<p align="center"><img src="build/icon.png" width="112" alt="Pilion"></p>

# Pilion Browser

[简体中文](README.md) | English

**Put your coding agent inside a real browser: your logged-in sessions, you present, and the wheel always within reach.**

Pilion is a desktop browser that hands its tabs to [Agent Client Protocol](https://agentclientprotocol.com) agents over MCP. It doesn't start a second, logged-out profile or move pages into a headless farm: the agent works in the browser you use every day, with your sessions. Its actions follow your approval settings, every step is audited, you can take over at any moment, and after a restart the conversation carries on.

![Pilion demo: an agent edits a cart, the user switches to confirm-before-acting and approves checkout, takes over to fix the address, and the session survives a restart](docs/demo.gif)

[Download](https://github.com/echoVic/pilion-browser/releases) · [Install](#install) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

## Why Pilion

- **Eight agents work out of the box**: Claude Code, Codex, Gemini CLI, Grok Build, OpenCode, Pi, Orca and Blade are detected automatically; when an ACP adapter is missing, a pinned version is installed into Pilion's data directory without touching the global CLI.
- **Full speed by default, brakes whenever you want**: new conversations start with Full access but are still audited; switch to Confirm before acting and every page-changing action waits for you, while a whole task can be allowed at once.
- **Take over, then hand back**: taking over stops the current turn but keeps the conversation, spaces, tabs and history. Continue task or Hand back and the agent carries on from the same tab.
- **Real primitives**: files are written straight into a page's `<input type=file>`; scrolling costs no approval; `<canvas>` / `<video>` surfaces such as whiteboards, maps and players take coordinate clicks, drags and wheel input.
- **Record once, replay as a skill**: record a demonstration, distil it into a skill, and the agent replays it later with `browser_skills_play`.
- **Remote agent, local browser**: the agent runs on a VPS and drives the local browser over SSH, so sessions stay on your machine.
- **Resumable and local-first**: every conversation stores its ACP session id and reconnects with `session/resume` or `session/load`; data stays local and the project is MIT.

## Install

Download the package for your platform from [Releases](https://github.com/echoVic/pilion-browser/releases):

| Platform | Package |
| --- | --- |
| macOS | dmg; choose arm64 for Apple silicon, x64 for Intel |
| Windows | exe installer; unsigned, so choose More info → Run anyway if SmartScreen warns |
| Linux | AppImage or deb |

Pilion checks for updates after installing, then asks to restart or installs on quit; turn that off in Settings › General › Updates. The Linux deb only reports a new version and must be downloaded by hand.

## Quick start

1. Open Settings › Agents and pick a local agent. An installed CLI or ACP adapter is reused; if the adapter is missing, choose Install and connect.
2. Pick permissions and a model in the right panel, then type a task, such as "Open GitHub and check my unread notifications".
3. To take over, choose Take over; when you're done, Continue task or Hand back. `⌘/Ctrl+Shift+O` lists all agent tasks.

Full access is the default. For payments, publishing or deletion, switch to Confirm before acting in the composer.

## Browser workspace

- Spaces on the left group tabs (Work, Reading and so on) and share sessions; a tab can be pinned to its space or shown in all spaces.
- Idle tabs are archived after 24 hours, except the current page, playing audio, recordings and agent tabs. Change the delay or turn it off in Settings › Browser, and restore from Archived tabs.
- `⌘/Ctrl+T` opens the command bar for tabs, bookmarks, history and commands; type `>` for commands only. The address bar takes URLs and searches, and find, zoom and downloads live in the toolbar.
- Extensions and browser data can import cookies / sessions and extensions from local Chrome, Edge, Brave or Chromium, and load unpacked Manifest V2 / V3 extensions; cookie import is macOS-only for now.
- The conversation panel on the right supports multiple sessions, streaming Markdown, collapsible tool calls and thinking, an approval dock, a task overview, image attachments and a send queue.

## Control and audit

- Approvals appear above the composer of the conversation that asked for them, and a page change, cancellation or disconnect invalidates them. Text from a page or the agent is flattened to one line so a newline can't forge an approval.
- Pause browser permission under the composer immediately revokes the agent's tab access; Share browser restores it.
- Every action, approval and connection event is written to the local `host.sqlite`. Tool result text older than 30 days and external call records older than 7 days are cleaned up at startup; audit entries are kept.
- Tab ACLs are per principal: an agent only operates tabs it opened. Pages run in a separate Electron `WebContentsView` sandbox, and there is no arbitrary JavaScript execution.

## External CLI / MCP

Pilion can expose the same controlled browser to terminal agents or MCP clients such as Claude Desktop and Cursor. It is off by default; enable External control in Settings › General.

```bash
pilion status
pilion tabs
pilion new https://example.com
pilion observe --tab <id>
pilion screenshot --tab <id> -o shot.png
pilion upload --tab <id> --ref-file ref.json --file /absolute/path/receipt.png
```

`--json` prints machine-readable results and `pilion skill` prints the full guide. External calls share the same approval, execution and audit path as built-in agents and expose 19 tools; `browser_request_human`, skill replay and scheduled tasks are not exposed. External control uses a Unix domain socket and isn't available on Windows; `cli.token` is a local file credential, so revoke the client in Settings if it leaks. The trust model is described in [Architecture](docs/architecture.md).

## Recording, skills and schedules

- Start recording from the toolbar, describe the steps and distil them into a skill stored locally that you can edit, rename or delete. Recordings skip passwords, card numbers, expiry dates, security codes and one-time codes.
- Agents discover skills with `browser_skills_list` and replay them with `browser_skills_play`; the first replay in a task needs your approval, and typing `/` in the composer inserts a skill.
- Scheduled tasks under Settings run a prompt for a bound agent on an interval, at a fixed time each day, on chosen weekdays or with a five-field cron. Unattended approvals are denied after 60 seconds, and an agent always needs your confirmation to create or delete a schedule.

## Security and data

- Pages run in a separate Electron `WebContentsView`; connections follow Chromium's and the system's DNS, proxy and routing settings, and downloads never open automatically.
- In userData, `agents.json` holds agent connections, `workspace.json` holds conversations, bookmarks, history and tabs, `host.sqlite` holds the audit log, and `schedules.json` holds scheduled tasks. JSON files are 0600 but not encrypted.
- There is one personal workspace for now, with at most four ACP sessions at a time; tabs an agent opens stay in the background until rendering or input is needed.
- No password manager or cross-device sync yet; Windows and Linux packages are unsigned.

## Development

You need Node.js 22.13+, pnpm 10, and Electron 43 runs the desktop app.

```bash
pnpm install
pnpm dev      # Vite, main-process watch and Electron
pnpm build
```

The Vite URL in `pnpm dev` only previews the interface; real pages, agents, approvals and persistence live in Electron.

Run the same checks as CI before committing:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:e2e   # builds first, then drives real Electron with Playwright; macOS only for now
```

`pnpm dist` writes the current platform's installer to `release/`, and `pnpm run pack` only creates an unpacked app directory. Pushing a `v*` tag starts the release workflow: after checks pass it builds on all three platforms and uploads a draft release, and fails without the signing secrets.

## Documents

[Architecture](docs/architecture.md) · [Arc features](docs/design/arc-features.md) · [Settings and menus](docs/design/settings-and-menu.md) · [Changelog](CHANGELOG.md) · [Skill for other agents](skills/pilion-browser/SKILL.md)

## License

MIT, see [LICENSE](LICENSE).
