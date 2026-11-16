# Working in this repository

Pilion is a desktop browser (Electron 43, TypeScript, React 19) that ACP agents drive through
approvals and an audit ledger. It ships to real users, so a change is done when its checks pass,
not when it compiles. User-facing text, comments, the README and the changelog are in Chinese;
keep new text in the language of the file you are editing. `README.en.md` is the English mirror of
`README.md`; change both together.

## Checks

Run all of these before saying a change is finished. CI runs the same ones.

```bash
pnpm typecheck      # renderer + main, both tsconfigs
pnpm lint
pnpm format:check   # `pnpm format` fixes it
pnpm test           # Vitest, about 2,000 tests
pnpm test:e2e       # builds, then drives the real Electron app with Playwright (macOS)
```

- The end-to-end run uses a temporary profile and does not take window focus. Do not start two
  runs at once: they share `dist/` and fail each other.
- A handful of unit tests spawn processes and can time out on a heavily loaded machine. Re-run the
  file on its own before treating one as a real failure.
- CI also runs typecheck and an explicit list of platform-neutral unit tests on Windows (job
  `windows` in `.github/workflows/ci.yml`). Add a new platform-neutral test to that list; renaming
  a listed file fails the job until the list is updated.
- The end-to-end suite is the record of intended behaviour. Before tightening a guard (for example
  refusing an action while an agent is connected), run it: two such guards were added during an
  audit and both contradicted flows the suite exercises on purpose.

## Where things are

| Path                      | What it is                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `src/main/main.ts`        | Main-process wiring: tabs, agent connections, approvals, IPC handlers, app lifecycle. |
| `src/main/host/`          | Approval and audit ledger (SQLite). Its state machines are in `state-machine.ts`.     |
| `src/main/agents/`        | ACP transport, local agent detection, the MCP bridge agents use to reach the browser. |
| `src/main/browser/`       | Tab registry and ACLs, the CDP page adapter, URL policy.                              |
| `src/main/external/`      | The control socket and the `pilion` CLI that terminal agents use; agent Spaces.       |
| `src/main/recording/`     | Recording a demonstration, distilling it into a skill, replaying it.                  |
| `src/preload/entry.cts`   | The preload Electron actually loads.                                                  |
| `src/preload/index.ts`    | Types for the renderer only. It must mirror `entry.cts`.                              |
| `src/shared/contracts.ts` | Zod schemas and the IPC channel table shared by main, preload and renderer.           |
| `src/renderer/`           | The trusted browser chrome (React). It never sees page content or principals.         |
| `skills/pilion-browser/`  | The skill installed into other agents. It is shipped inside the app.                  |
| `docs/architecture.md`    | Module-by-module description; update it when a module's job changes.                  |

## Things that will trip you up

- **A new IPC method touches four places**: the channel in `src/shared/contracts.ts`, the handler
  in `main.ts`, and the method in both `src/preload/entry.cts` and `src/preload/index.ts`. The
  end-to-end suite pins the method names of the real bridge, so update that list too.
- **About twenty unit tests run `main.ts` functions from their source text** in a `vm` context
  with hand-built globals (`grep -ln runInNewContext tests/ -r`). If a function they extract starts
  using a new module-level name, add that name to the test's context, or the test fails with a
  `ReferenceError`. Renaming an extracted function fails the test that names it.
- **New lifecycle state goes in a named phase, not another boolean.** Follow the existing ones;
  each has a diagram or a union in its file: `host/state-machine.ts` (ledger),
  `agents/conversation-link.ts` (per-conversation connection), `agents/transport.ts` (turn),
  `browser/recording-channel.ts` and `recording/session.ts` (recording), `external/server.ts`
  (control socket), `updater.ts` (install), `shutdownPhase` in `main.ts`, and in the renderer
  `composer/phase.ts` and `overlay.ts`.
- **Files in `userData` are written by temp file plus rename and read entry by entry**
  (`agent-config-store.ts`, `schedule/store.ts`, `external/client-registry.ts`). A reader that rejects the whole file on one bad
  entry will lose the rest on the next save.
- **Text that reaches an approval card is flattened first.** Anything derived from a page or
  supplied by an agent goes through `approvalLine` in `src/main/approval-text.ts`, so it cannot add
  lines to the trusted summary.
- **Two lists must agree:** the local-file extensions in `src/main/local-file.ts` and
  `src/renderer/panel/links.ts` (a test compares them), and the two preload files (a test compares
  them byte for byte).
- **`main.ts` is large.** Put new logic in a module next to it with its own test, and keep
  `main.ts` to wiring.

## Boundaries

- Commit, push, tag or publish a release only when asked. Other tools also commit to this
  repository, so run `git fetch` and `git status -sb` before any git operation that depends on the
  branch state.
- Do not run the "install to agents" flow, or anything else that writes outside the repository
  (`~/.claude/skills`, `~/.local/bin/pilion`), against the real home directory as part of testing.
  The tests use temporary directories for this.
- `.superpowers/`, `.boss/`, `.trae/`, `ui-checks/` and everything under `.claude/` except the
  tracked skill link are local and ignored; leave them out of commits.
- The external control socket, approvals, tab ACLs and the ledger are the product's security
  boundary. A change there needs a test that fails without it.
