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
| Second write threw "could not be cloned" | Handing a Solid store proxy to IndexedDB; both are valid types, and the first import never hits it |
| Tab count shown on a bookmark filter | Both are integers — nothing static can tell "171 tabs" from "171 matches" |
| Status edits never reached IndexedDB | A one-level spread left nested store proxies behind; the UI showed the new value and the write threw silently |

## Running

```bash
npm run build
./scripts/e2e/launch.sh            # prints whether the service worker registered
node scripts/e2e/import-test.mjs
node scripts/e2e/switch-test.mjs
node scripts/e2e/popup-panel-test.mjs
node scripts/e2e/tabs-test.mjs
node scripts/e2e/triage-test.mjs
```

Each script exits non-zero on failure. **Run them in order, against a fresh browser**
(`launch.sh` wipes its profile): `import-test` expects an empty library, and `tabs-test`
expects a populated one — capturing into a non-empty store is exactly the case that broke
before, so it deliberately runs near the end rather than in isolation. It computes every
expectation from live state, so it does not care how many tabs the earlier scripts left
open.

`triage-test` runs **last** because it is the only script that deletes records. It seeds
its own and narrows to them with the search box, so it does not disturb anything the
others rely on — but a script that destroys data has no business running ahead of ones
that count it.

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
