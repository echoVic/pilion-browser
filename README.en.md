<p align="center"><img src="build/icon.png" width="112" alt="Pilion"></p>

<h1 align="center">Pilion Browser</h1>

<p align="center"><b>Your coding agent, inside your real browser — your logins, your call, your hand on the wheel.</b></p>

<p align="center">
<a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
<a href="https://github.com/echoVic/pilion-browser/releases"><b>Download</b></a>
&nbsp;·&nbsp;
<a href="#install">Install</a>
&nbsp;·&nbsp;
<a href="#quick-start">Quick start</a>
&nbsp;·&nbsp;
<a href="docs/architecture.md">Architecture</a>
&nbsp;·&nbsp;
<a href="CHANGELOG.md">Changelog</a>
</p>

![Pilion demo: ask the agent to update a shopping cart, switch to approve-before-action and allow the checkout click, take over to edit the address, then resume the session after a restart](docs/demo.gif)

Pilion is a desktop browser that hands its tabs to an [Agent Client Protocol](https://agentclientprotocol.com) agent over MCP. No headless browser farm, no fresh logged-out profile: the agent works inside the browser you actually use, with your logins. Actions follow your approval settings and are written to an audit ledger; you can take over at any time, and a restart picks the conversation back up.

## Why Pilion

- **Eight agents out of the box** — Claude Code, Codex, Gemini CLI, Grok Build, OpenCode, Pi, Orca and Blade are detected automatically; a missing ACP adapter is installed at a pinned version into Pilion's data directory, and global CLIs are left untouched.
- **Freedom by default, brakes when you want** — a new conversation starts with full access and is still fully audited. Switch it to approve-before-action and every page-changing action waits for you; one "allow for this task" covers the whole task.
- **Take over, then hand it back** — taking over stops the current turn, not the session: the conversation or space, its tabs and the history stay. "Resume task" continues a chat; "Hand back" returns an external Agent Space; only "Convert to my space" is irreversible.
- **Uploads, scrolling and canvas input are primitives** — files go straight into an `<input type=file>`; scrolling costs no approval; whiteboards, maps and players drawn into `<canvas>` / `<video>` accept coordinate clicks, drags and wheels.
- **Record once, replay as a skill** — capture a walkthrough, distill it into a skill, and let the agent replay it with `browser_skills_play` instead of rediscovering the same pages.
- **Remote agent, local browser** — run the agent on a VPS over SSH while it drives the browser on this machine, against your logged-in session.
- **Resumable sessions** — each conversation keeps its ACP session id and reconnects with `session/resume` or `session/load`, so a restart never means starting over.
- **Local-first** — data stays on your machine and the project is MIT licensed; macOS, Windows and Linux builds update themselves once installed.

## Install

Download the package for your platform from [Releases](https://github.com/echoVic/pilion-browser/releases):

| Platform | Package                                                                    |
| -------- | -------------------------------------------------------------------------- |
| macOS    | dmg; pick arm64 for Apple Silicon or x64 for Intel                         |
| Windows  | exe installer; unsigned, so choose "More info → Run anyway" on SmartScreen |
| Linux    | AppImage or deb                                                            |

After installation Pilion checks for and downloads updates, then asks you to restart or installs on quit; turn this off under Settings › General › Updates. A Linux deb only announces a new version and needs a manual download.

## Quick start

1. Open Settings › Agent and pick a local agent. An existing CLI or ACP adapter is reused; if one is missing, click "Install and connect".
2. Choose the permission mode and model in the right-hand panel, then type a task — "Open GitHub and check my unread notifications", for example.
3. Click "Take over" when you need the wheel. When you are done, click "Resume task" or "Hand back". Press `⌘/Ctrl+Shift+O` for the task overview.

New conversations start with full access. For payments, publishing or deleting, switch the composer to approve-before-action first.

## The browser workspace

- Spaces on the left (Work, Reading, …) group tabs and share logins; a tab can be pinned to one space or made visible in all of them.
- An idle tab archives after 24 hours; the active page, playing audio, recordings and agent pages stay. Change or disable this under Settings › Browser and restore pages from Archived tabs.
- `⌘/Ctrl+T` opens the command bar for tabs, bookmarks, history and commands; type `>` to search commands only. `⌘/Ctrl+Shift+C` copies the current URL.
- The address bar takes URLs and searches; find-in-page, zoom and downloads live in the toolbar. On macOS Pilion can be set as the default browser.
- Extensions & browser data imports cookies/logins and extensions from a local Chrome, Edge, Brave or Chromium, and loads unpacked Manifest V2 / V3 extensions; cookie import is macOS-only for now.
- The right-hand panel supports multiple conversations, streaming Markdown, collapsible tools and reasoning, an approval dock, the task overview, image attachments and an outgoing queue.

## Agent connections

- Eight local presets; Pilion looks for their binaries in PATH, nvm, Homebrew, Volta, `~/.grok/bin`, `~/.opencode/bin` and similar places, and a Node.js path and working directory can be set by hand. The default working directory is `workspace-files` under userData.
- A missing adapter is installed with npm at a pinned version into `userData/adapters/`, first into a temporary directory and enabled only after it passes the full check. Global CLIs are not modified and a failed install leaves nothing behind. Pi and Blade need Node.js 22.19+; native executables do not need Node.js.
- "Custom / remote" accepts any ACP stdio command (arguments as a JSON array, with environment variables and an auth method) and SSH remotes: ACP runs over SSH stdio while the browser MCP uses a separate private Unix-socket hop back to this machine, so the remote never needs Pilion installed.
- An SSH remote needs a Unix host with the agent installed and a netcat that supports `nc -U`; this machine must be able to log in with a key and already trust the host fingerprint.
- Each conversation binds one agent and up to four sessions run at once. Permission mode, model and session are stored per conversation.

[Orca](https://github.com/echoVic/orca-agent) is a DeepSeek-native coding agent and [Blade](https://github.com/echoVic/blade-code) supports 38+ model providers; both are maintained by Pilion's author, implement ACP natively and pick up the browser tools Pilion exposes.

## Control and audit

- Approvals appear above the composer of their conversation, with their buttons always visible; a page change, cancellation or disconnect invalidates them.
- Under approve-before-action you can allow once or allow the whole task; an external client can also be always allowed. "Allow for this task" covers the current task; for an external client the Space grant survives reconnects and ends when the space ends or is taken over.
- Text that reaches an approval card from a page or an agent is flattened to one line first, so it cannot forge extra lines in the trusted summary.
- "Pause browser access" below the composer revokes the agent's tab access immediately; "Share browser" restores it.
- Every action, approval and connection event is written to the local `host.sqlite` ledger; on startup, tool-result bodies older than 30 days and external-call records older than 7 days are cleaned up, while the audit entries themselves remain.
- Tab ACLs are per principal: an agent can only touch tabs it opened itself; your own tabs are not exposed to it.
- There is no arbitrary JavaScript execution; pages run in a separate Electron `WebContentsView` sandbox.

## Browser primitives

Pilion exposes 24 built-in tools over MCP:

- **Observe**: `browser_observe`, `browser_snapshot`, `browser_screenshot`, `browser_page_info`.
- **Interact**: `browser_navigate`, `browser_click`, `browser_hover`, `browser_pointer`, `browser_type`, `browser_select`, `browser_check`, `browser_press`.
- **Viewport and files**: `browser_scroll`, `browser_upload_file`.
- **Tabs**: `browser_tabs_list`, `browser_tabs_open`, `browser_tabs_activate`, `browser_tabs_close`.
- **Skills, schedules and hand-back**: `browser_skills_list`, `browser_skills_play`, `browser_schedule_create`, `browser_schedule_list`, `browser_schedule_delete`, `browser_request_human`.

A few details worth knowing:

- `browser_observe` returns up to 200 DOM candidates and element references; on oversized pages `browser_screenshot` downgrades to JPEG or a smaller scale automatically, accepts `scale`, `quality`, `format` and `clip`, and reports the image-pixel / CSS-pixel ratio.
- `browser_pointer` is only for `<canvas>` / `<video>`, with coordinates relative to the top-left of the surface content box. Its result only says `dispatched`; take another screenshot to confirm a reaction. Points outside the visible viewport or covered by another element are refused before any input is dispatched.
- `browser_upload_file` writes files directly into an `<input type=file>`, including a hidden one. It only accepts absolute paths to regular files, rejects symlinks, allows 200 MB per file and 10 files at once, and reads the page back to verify.
- `browser_scroll` moves the viewport without changing page state, so it is not gated by approval.
- For controls with no layout or hover-only controls, call `browser_hover` first or use `browser_click` with `force: true` (`pilion click --force` from the CLI); `browser_press` returns `effect: activated | none | dispatched` instead of a bare `ok: true`.

## Recording and skills

- Click "Start recording" in the toolbar, perform the walkthrough, add a description and distill it into a skill. Skills are stored locally and can be edited, renamed and deleted.
- Recordings do not capture passwords, card numbers, expiry dates, security codes or one-time codes, and login credentials in a URL are not written into a replay.
- An agent finds skills with `browser_skills_list` and replays them with `browser_skills_play`; the first replay in a task asks you once. Typing `/` in the composer inserts a skill into the prompt.
- A skill edit written by an agent in chat is a proposal until you confirm it.

## Scheduled tasks

- Settings › Scheduled tasks can run a prompt for a bound agent in the background on an interval, once a day, on chosen weekdays, or on a five-field cron rule. It sends a system notification when done, and a run missed during sleep catches up after launch or wake.
- Each task chooses its own permission mode, defaulting to approve-before-action; an unattended approval is denied after 60 seconds. A schedule created or deleted by an agent always needs your confirmation in the source conversation.
- A run opens its own background conversation, then disconnects its dedicated connection and releases the slot; the same task never overlaps itself.

## External CLI and MCP

Pilion can expose the same governed browser to terminal agents, or to MCP clients such as Claude Desktop and Cursor. This is **off by default**; turn it on under Settings › General › External control.

- "Install to Agent" issues a local client, writes its token to `userData/external/cli.token` (0600), installs `~/.local/bin/pilion`, and copies the `pilion-browser` skill into the existing Claude Code, Codex, WorkBuddy, Gemini, Trae and Cursor skill directories.
- If you only want the skill, `npx skills add echoVic/pilion-browser` installs it without the desktop app.
- A new external client gets a token that is shown only once; the client registry keeps only its scrypt hash. Each client has its own principal and tab ACL, and by default can only operate tabs it opened. New clients (including the one from "Install to Agent") default to always allow; switch one back to approve-before-action in the client list. Creating a client also gives you its MCP config JSON to paste into `mcpServers`.
- External calls go through the same approval, execution and audit chain as a built-in agent and expose 19 tools. `browser.request_human`, `browser.skills.play` and the three `browser.schedule.*` tools are not exposed, and there is no arbitrary JavaScript execution.

```bash
pilion status
pilion tabs
pilion new https://example.com
pilion observe --tab <id>
pilion click --tab <id> --ref-file ref.json
pilion pointer click --tab <id> --ref-file canvas.json --at 120,80   # canvas/video only
pilion screenshot --tab <id> -o shot.png
pilion upload --tab <id> --ref-file ref.json --file /absolute/path/receipt.png
```

Add `--json` for machine-readable output; `pilion skill` prints the full guide shipped with the app. Each external agent conversation can also own an Agent Space:

```bash
SPACE=$(pilion space new "price comparison")
pilion navigate --space "$SPACE" https://example.com/
pilion screenshot --space "$SPACE"
pilion space close "$SPACE"
```

**The trade-off**: `cli.token` is a file credential, and any local process running as you can read it. Like any other external client it is still constrained by approvals, ACLs and audit; if it leaks, revoke that client in Settings. External control is built on a Unix domain socket and is not available on Windows. See the [architecture notes](docs/architecture.md) for the full trust model.

## Security and data

- Pages run in a separate Electron `WebContentsView`; networking follows Chromium and the system's DNS, proxy and routing settings, so it can reach the public internet, a LAN and local HTTP(S) services. Downloads never open automatically.
- Under userData, `agents.json` stores connection configs, `workspace.json` stores conversations / bookmarks / history / tabs, `host.sqlite` stores the execution audit and `schedules.json` stores scheduled tasks. JSON files are 0600 but are not encrypted.
- There is a single personal workspace, and up to four ACP sessions run at once; tabs an agent opens stay in the background and only wake when they need rendering or input.
- There is no password manager or cross-device sync yet. Windows and Linux packages are unsigned. The ACP HTTP transport is still a draft, so remotes use standard stdio over SSH.

## Development

Requires Node.js 22.13+, pnpm 10; the desktop app is built on Electron 43.

```bash
pnpm install
pnpm dev      # Vite + main-process watch + Electron
pnpm build
pnpm start
```

The Vite URL from `pnpm dev` is only for previewing the UI; real pages, agents, approvals and persistence need Electron.

Before sending a change, run the same checks as CI:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:e2e
```

E2E builds first, then drives the real Electron app with Playwright (macOS only for now). Every run uses an isolated profile under `os.tmpdir()` — it never touches your daily `~/Library/Application Support/pilion-browser` — and does not steal system focus. E2E runs share `dist/`, so do not start two at once. Point `PILION_E2E_EXECUTABLE` at a packaged executable to validate the installer with the same suite.

If Electron fails with `bad option: --remote-debugging-port=0`, check for `ELECTRON_RUN_AS_NODE=1` in the environment and retry with `env -u ELECTRON_RUN_AS_NODE pnpm test:e2e`.

## Packaging and releases

```bash
pnpm dist       # installer for the current platform, written to release/
pnpm run pack   # unpacked app directory, for a local smoke test
```

Pushing a `v*` tag starts GitHub Actions: typecheck, lint, format checks and unit tests run first, and the tag must match the `package.json` version; only then are macOS, Windows and Linux packages built and uploaded to a draft release. With `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` configured, the macOS package is signed and notarized automatically; the release workflow fails when they are missing, so it never publishes a package that cannot auto-update. E2E is not part of the release path; CI runs it on every push to main. Installed copies start updating only after the draft release is published.

## Documentation

- [Architecture](docs/architecture.md) — modules, state machines, external channels and security boundaries.
- [Arc feature design and acceptance](docs/design/arc-features.md) — spaces, tabs and the command bar.
- [Settings and menus](docs/design/settings-and-menu.md).
- [Changelog](CHANGELOG.md) — what changed in every release.
- [skills/pilion-browser](skills/pilion-browser/SKILL.md) — the bootstrap skill installed into other agents.

The app UI and the design docs linked above are currently in Simplified Chinese.

## License

MIT — see [LICENSE](LICENSE).
