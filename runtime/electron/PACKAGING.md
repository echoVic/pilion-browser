# Native runtime packaging gate

Release packaging requires accepted native Electron artifacts. It never falls back to the
npm Electron binary. The npm binary remains a development dependency; it does not
prove native `chrome.userScripts` or Tampermonkey compatibility.

Set `PILION_ELECTRON_ARTIFACTS` to a directory containing one subdirectory for each
requested target: `darwin-arm64`, `darwin-x64`, `win32-x64`, or `linux-x64`.
Each target directory contains:

- `dist.zip`: the native Electron distribution produced from `build-lock.json`.
- `receipt.json`: the build verification receipt, completed after actual acceptance.
- `tampermonkey-acceptance.json`: recorded acceptance of the original extension.

`build.mjs verify` produces the native fixture receipt with
`tampermonkey: "not-yet-tested"`. This intentionally cannot pass the packaging gate.
Only after testing the original Tampermonkey publisher payload on that exact
native distribution through Pilion's normal import and extension UI, record its
version, original package hash, target, archive hash, and
these observed results:

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "zipSha256": "<SHA-256 of dist.zip>",
  "extensionId": "dhdgffkkebhmkfjojejmpbldmpobfkfo",
  "version": "5.5.1",
  "packageSha256": "<SHA-256 of original Tampermonkey package>",
  "unmodified": true,
  "managedCopyTransforms": ["storage-compat-prepend"],
  "checks": {
    "domInjection": true,
    "navigation": true,
    "restart": true,
    "revocation": true
  }
}
```

The version must identify the package actually tested. `domInjection` means a
userscript installed through the original extension UI changes the intended page;
`navigation` means it runs again after navigation; `restart` means registration
survives a browser restart; `revocation` means revoking access prevents execution.
Keep detailed logs/screenshots with the acceptance run. These JSON fields are a
trusted operator's recorded results, not an automated certificate of functionality.
Never fill them from fixture-only results or mark unrun checks as passed.

`unmodified` means the publisher's JavaScript payload has not been patched or
replaced with a test fixture. It does not mean the runtime directory is byte
identical to the original package: Pilion prepends its storage shim to static
content scripts in its own managed manifest copy. Record those host changes in
`managedCopyTransforms` (use `[]` when no managed files changed), retain the
original package hash separately, and test the actual managed copy. Diagnostic
edits to publisher JavaScript must be removed before acceptance.

In the matching native fixture receipt, set `tampermonkey` to `"passed"` and add:

```json
{
  "tampermonkeyEvidence": {
    "file": "tampermonkey-acceptance.json",
    "sha256": "<SHA-256 of the exact acceptance JSON file bytes>"
  }
}
```

Retain all fields from native verification, including `receiptVersion: 2`,
`verifiedAt`, `electron`, `commit`, `patchSha256`, `sourceTree`, `platform`, `arch`,
`binarySha256`, `extractedSha256`, `nativeFixture: "passed"`, and `zipSha256`.
Legacy receipts containing only `nativeFixture: "passed"` are rejected.

The `phases` array must preserve all four fixture markers in order: `register`,
`restore`, `revoke`, `revoked`. Each marker contains its `phase`, `injected`,
`allowed`, and `runtime` object (`electron`, `chromium`, `platform`, `arch`). The
first two markers require both booleans true; the last two require both false.
Every runtime identity must match the locked versions and requested target.
The wrapper launches the executable extracted from the mandatory ZIP and matches
its hash to the requested executable before recording these markers. The packaging
gate independently hashes the executable member of that ZIP and requires it to
match both `binarySha256` and `extractedSha256`; it never needs access to the
original build machine's absolute paths. Python 3 must be available as `python3`
(macOS/Linux) or `python` (Windows) for this streaming ZIP check.

`sourceTree` records the exact patched Git source tree. The receipt, source hash,
and runtime-reported versions do not independently attest that an arbitrary binary
was compiled from that source; the reviewed native bundle remains a trusted input.

Hashes use
lowercase hexadecimal. Every receipt must match the source/patch locks, current
Electron dependency, requested target, and archive bytes. Acceptance evidence is
also bound to that archive. Any missing or mismatched result stops packaging.
Architectures are packaged serially because electron-builder shares its config.

## Release bundle

On suitable native build machines, build and test each target independently. Put
the target directories directly at the root of `pilion-native-electron.zip`.
The workflow accepts only the three named files per supported target; it rejects
unexpected files and duplicate names. Missing target files fail the packaging gate.

Upload the reviewed bundle to a versioned release of this repository, using tag
`native-electron-${electronTag}-${first12CharactersOfPatchSha256}` (values from
`build-lock.json`). Then configure these repository variables:

- `PILION_NATIVE_ELECTRON_BUNDLE_URL`: exactly
  `https://github.com/<owner>/<repo>/releases/download/<native-tag>/pilion-native-electron.zip`.
- `PILION_NATIVE_ELECTRON_BUNDLE_SHA256`: the reviewed bundle's SHA-256.

The release workflow requires that URL and checksum before compiling the app. It
downloads an existing bundle and verifies it; it does not launch native Chromium
builds on hosted runners. Each packaging target then verifies its individual
archive and receipt. Missing variables fail the workflow. For local packaging of an accepted native build, pass
`-c.beforePack=./runtime/electron/packaging.mjs -c.concurrency.jobs=1` and set
`PILION_ELECTRON_ARTIFACTS`. An ordinary local `pnpm pack` uses stock Electron.

No accepted native bundle or original Tampermonkey result is supplied by these
instructions. Packaging remains blocked until those results exist.
