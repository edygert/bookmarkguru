# End-to-end verification

`npm run check` covers everything that can be checked without a browser. These scripts
cover what it cannot: manifest correctness, **service worker registration**, `chrome.*`
wiring, and whether the UI actually renders.

That gap is not theoretical. Every bug that has reached this project was found here
rather than by `tsc`, vitest, or the build:

| Bug | Why the static checks missed it |
|---|---|
| `manager.html` never built | CRXJS only builds manifest-declared HTML; the build "succeeded" |
| Open-now badge never matched | Compared a dedupe-normalized key against a match-normalized set — both valid types |
| Virtual list rendered zero rows | Library bug; container got the right height, so nothing looked wrong |
| Undeclared `contextMenus` permission | `@types/chrome` declares the whole API regardless of the manifest |
| Empty domain for `file://` URLs | Correct code, wrong product behaviour |

## Running

```bash
npm run build
./scripts/e2e/launch.sh            # prints whether the service worker registered
node scripts/e2e/import-test.mjs
node scripts/e2e/switch-test.mjs
node scripts/e2e/popup-panel-test.mjs
```

Each script exits non-zero on failure. Run them against a **fresh** browser
(`launch.sh` wipes its profile) — `import-test` expects an empty library.

Override defaults with `BG_PORT`, `BG_EXT_ID`, `BG_BROWSER`.

## Environment notes

- **`--password-store=basic` is required.** Without it the browser blocks forever on a
  system-keyring prompt that never appears in a headless session.
- Only Brave is installed here. It is Chromium-based, so MV3 behaves the same.
- The extension ID is derived from the `dist/` path, so it is stable across runs.
  If you move the project, update `EXT_ID` in `cdp.mjs` or set `BG_EXT_ID`.

## Debugging a missing service worker

`launch.sh` reports `service_worker: NOT RUNNING` when registration fails. Registration
failures are **silent** — no console error, no failed build, the extension just does
nothing. The usual cause is a `chrome.*` namespace used without its manifest
permission: the namespace is `undefined`, `.addListener` throws during module
evaluation, and the worker dies before registering.

`npm run guard:permissions` catches that case specifically. If it passes and the worker
still will not start, bisect by replacing `dist/service-worker-loader.js` with a bare
`console.log(...)` and re-launching — if that registers, the fault is in the worker's
own code or its imports rather than the manifest.
