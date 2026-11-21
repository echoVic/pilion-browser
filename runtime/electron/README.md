# Pilion native Electron extension runtime

This patch targets Electron **v43.7.9**, commit
`c41115bbafc47647b80a9a9f6f298392330eff88`, embedding Chromium
**150.0.7871.250**. The patch has an accepted macOS arm64 build as recorded below. Each additional
target needs its own build and acceptance results.

## Native userScripts patch

`patches/0001-userscripts.patch` retains Chromium's real script registry,
extension-associated `USER_SCRIPT` isolated worlds, CSP, host permission checks,
frame/document scheduling and native extension messaging. It adds no eval shim,
no unconditional permission bypass and no security-reducing launch switches.

The changes are bounded to:

- Install Chromium's existing `user_scripts_availability` delegated availability
  handlers in `ElectronExtensionsClient` before API feature providers populate.
  Existing entries in the delegate map are retained.
- Add session-scoped native `getUserScriptsAllowed` and `setUserScriptsAllowed`.
  Unknown or cross-session IDs throw; granting requires the extension's active
  `userScripts` permission. Consent defaults to false. The setter delegates to
  Chromium's `UserScriptManager::SetUserScriptPrefEnabled`, which persists
  consent, updates script sources and refreshes loaded page/worker bindings.
- Back `dynamic_user_scripts_store()` with Chromium `StateStore`, using its
  `SCRIPTS` database and the session's existing `ValueStoreFactory`. The extension
  system owns the store, creates it before UserScriptManager, and destroys it
  after script loaders. In-memory sessions remain unsupported for extensions.
- Add API documentation and native behavioral specs/fixtures, including a worker
  which never re-registers scripts, so the restart test depends on real storage.

Integration uses the session containing the loaded extension:

```js
const extension = await browserSession.extensions.loadExtension(extensionPath);
const allowed = browserSession.extensions.getUserScriptsAllowed(extension.id);
// Call from an explicit user setting, after the user has granted this consent.
browserSession.extensions.setUserScriptsAllowed(extension.id, true);
```

The getter returns a synchronous boolean; the setter returns void and throws
validation errors synchronously. The setter returns synchronously. Chromium refreshes page and running worker
bindings through its IPC path; an extension must wait for API availability before
registration. Reloading the extension is not required by this integration. Tampermonkey 5.5.1
already polls for `chrome.userScripts` availability every three seconds after its
initial missing-API warning and retries native registration when it appears.
Revocation prevents future injections and cannot undo scripts already executed
in existing pages. The host must not silently enable consent during import.

No extra host permissions are granted. Extensions still must be loaded on every
app boot, using the same persistent session and extension identity. Reusing a
fresh profile cannot prove restart persistence.

## Applying and verifying

Apply to the exact clean Electron tag after checking out the pinned source:

```sh
git apply --check /absolute/path/to/0001-userscripts.patch
git apply /absolute/path/to/0001-userscripts.patch
```

The source patch changes Electron files only; it does not edit Chromium sources.
Its calls use API signatures verified against Chromium 150.0.7871.250. The
`userScripts` permission is already registered as `kUserScripts` by Chromium
`extensions_api_permissions.cc` through Electron's existing CoreExtensionsAPIProvider;
the native setter checks that parsed active permission, not manifest strings. The
existing Electron build already depends on `//extensions/common` (which includes
`user_scripts_availability.cc`) and `//extensions/browser` (which includes
StateStore and the native userScripts implementation). A real GN compile/link
remains necessary to confirm this integration in the complete pinned checkout.

Build with the project's pinned Electron build configuration and complete
Chromium/Node dependencies. On macOS this requires full supported Xcode and its
SDK, not Command Line Tools alone. Do not replace the app's runtime until the
custom binary, generated Electron TypeScript definitions, full native specs and
Pilion acceptance suite pass. Kernel packaging/signing and release identity are
handled by the runtime build pipeline, separately from applying this patch.

The new specs in `spec/extensions.spec.ts` under `native userScripts` exercise:

1. Default denial and failed registration before explicit consent.
2. Consent enabling a real native script that modifies a page DOM.
3. USER_SCRIPT globals isolated from the page's main world.
4. Already-running worker namespace rebinding, with a worker-instance nonce
   proving grant does not depend on restarting the worker.
5. Native `onUserScriptMessage` round-trip and sender extension/URL attribution.
6. A fresh process restoring the registered script and world messaging without
   the extension worker re-registering any script.
7. Consent revocation preventing injection into a new document, retained after
   another process restart.
8. Excluded pages staying unchanged.
9. Invalid extension IDs and missing userScripts permission being rejected.

The fixture runner is `spec/fixtures/extensions/user-scripts/main.js`, with
phases `register`, `restore`, `revoke`, `revoked`, each run in a separate process
against one disposable profile. Each child uses an explicit fresh `--user-data-dir`,
`NODE_ENV=test`, and `PILION_E2E_NO_FOCUS=1`. On macOS the fixture honors that
flag by calling `app.setActivationPolicy('accessory')` before ready. Its controller and target windows are hidden,
sandboxed, isolated and have Node integration disabled. Run fixtures only using
an actual generic Electron executable, never a packaged Pilion executable,
which executes its own app entrypoint instead of the fixture script.

After a native build, run the Electron native specs, then test the **original
Tampermonkey 5.5.1 package** through its UI with a new local QA userscript. Prove
visible page modification, navigation/reload, app restart and consent revocation.
Include cross-session/host/frame boundaries, world CSP and service worker restart
in acceptance. Keep sandbox, context isolation, web security and site isolation
active. The fixture extension alone does not certify Tampermonkey compatibility.

## Extension tab compatibility

The embedder reports its selected page to `setActiveTabId`, so an extension
popup can query the user's active tab even while the popup owns keyboard focus.
Native `tabs.create` can open a page belonging to the calling extension through
`setTabCreationHandler`. Pilion creates a sandboxed child window in the same
session for that request. Window placement, tab order and opener relationships
remain under embedder control. This supports the dashboard and editor used by
Tampermonkey 5.5.1.

The native `chrome.storage.sync` namespace uses Chromium's storage quota and
change events with a separate database inside the current browser profile.
Settings persist across launches and stay local to the machine.

## Validation recorded on 2026-11-21

- The patched macOS arm64 framework compiled and linked. The verification
  wrapper extracted `dist.zip` and ran all four native fixture phases.
- An untouched Tampermonkey 5.5.1 package from the Chrome Web Store update
  service was imported through Pilion's UI using a disposable Chrome profile.
  The toolbar popup opened the editor. The script executed against a loopback
  page, survived navigation and app restart, and stopped after revocation.
- The same flow passed in a local unsigned arm64 Pilion application bundle.
  macOS x64, Windows x64 and Linux x64 have no native acceptance results yet.
- The native fixture also verifies selected-tab lookup, same-extension page
  creation and persistent, distinct `local` and `sync` storage. Immersive
  Translate 1.35.4 renders its original popup with local sync storage. Translation
  service calls and the other extensions' core actions still need acceptance.

## Native source references

- [Chromium API availability feature](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/common/api/_api_features.json#L886)
- [Existing delegated consent check](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/common/user_scripts_availability.cc)
- [Consent setter and renderer refresh](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/browser/user_script_manager.cc#L127)
- [Running worker binding refresh](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/renderer/dispatcher.cc#L1457)
- [Dynamic script storage](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/browser/extension_user_script_loader.cc#L813)
- [Chromium StateStore lifecycle](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/browser/state_store.h)

- [Core userScripts permission registration](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/common/permissions/extensions_api_permissions.cc#L160)
- [Core provider registering permissions](https://github.com/chromium/chromium/blob/150.0.7871.250/extensions/common/core_extensions_api_provider.cc#L56)
