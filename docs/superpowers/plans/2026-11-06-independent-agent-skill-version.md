# Independent agent skill version fix

**Goal:** The desktop app and bootstrap skill can be upgraded independently; app startup and reinstall never downgrade a newer skill.

**Scope:** The description approved in chat on 2026-11-06. Keep the CLI and runtime guide bundled with the app. Keep existing credential, shim, ownership, and missing-target behavior.

## Implementation

- [x] Add filesystem regression cases for app-only upgrades, skill-only upgrades, newer independently installed skills, reinstall, and legacy markers. Run them against the old implementation and confirm failures.
- [x] Read the bootstrap version from `SKILL.md` metadata. Stable three-component release versions are ordered numerically; missing or unrecognized installed versions are preserved. Store ownership schema and skill version separately in `.pilion-managed`, accepting existing plain-text markers. Use the actual installed metadata when an external skill update leaves a stale marker.
- [x] Use the same upgrade-only policy for startup and explicit reinstall. Validate bundled metadata before issuing a credential. Preserve foreign directories and deleted targets.
- [x] Give the bootstrap its own `1.0.0` version, retain command discovery, full-guide sentinel and setup fallback, and keep runtime-specific rules in `pilion skill`. Remove the app-version equality test; document independent updates and legacy migration.
- [x] Run focused tests, typecheck/build, lint, full unit suite, a compiled-CLI guide smoke check, and an independent code review. No release or real user installation is part of this fix.

## Review focus

- App version changes with unchanged skill must leave the installed skill untouched.
- Independently installed newer metadata takes precedence over stale app or skill receipts.
- Legacy app-version markers must not be interpreted as skill versions.
- Invalid installed metadata must not authorize a destructive overwrite; invalid bundled metadata fails before credential issuance.
- Reinstall and startup must agree on downgrade protection; ownership and missing/foreign-directory boundaries stay intact.

## Verification recorded

- Before the fix, baseline package/integration tests: 29 passed. Added regressions reproduced app-only rewriting, missed skill-only upgrades, newer-skill downgrades, and invalid bundle acceptance (14 failures).
- Focused package/integration/CLI tests after the fix: 109 cases; the independent reviewer ran these plus wiring tests (120 passed across five files).
- Full unit suite: 105 files, 1,492 tests passed after parser hardening.
- `pnpm run build` (including both typechecks), `pnpm run lint`, scoped Prettier check and `git diff --check`: passed. Build retains the existing chunk-size warning.
- Compiled CLI smoke check with credential-free environment: CLI `0.2.1`, bootstrap `1.0.0`, guide 16,298 bytes, sentinel present.
- Real Electron regression `安装到 Agent installs a working pilion command and removing it revokes access`: 1 passed (final run: 15.7 seconds), using a temporary home/profile.
- Independent review: no remaining findings. A duplicate metadata-block case found during review was reproduced RED, fixed and verified GREEN alongside malformed/duplicate version cases; the final full suite/build/lint and Electron regression passed afterward.
- Review scope excluded external third-party skill installation, already released pre-fix binaries, and cross-process races with another installer. Electron effects were verified by the integration regression above. No dependency, release, or real user installation changes were made.
- Concurrent WorkBuddy integration/UI edits were retained; its receipt assertion was adapted to the new format.
