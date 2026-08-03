# BookmarkGuru

A Chrome MV3 extension that replaces the bookmark manager with a personal link database:
search-first, tag-based, tab-aware.

Chrome's bookmark tree is treated as an import bridge only — never the live data model,
never the primary UI, and nothing is exported back to it. On import, folders become tags,
so a link filed in one place stays findable by any of its attributes.

## Status

Phases 1 and 2 are complete and runtime-verified. This is not on the Chrome Web Store;
it installs unpacked. Remaining work is tracked at the top of [PROGRESS.md](PROGRESS.md).

## Install

Requires Node 20.19+ (the floor for Vite 8).

```bash
npm install
npm run build
```

Then load it at `chrome://extensions`: enable **Developer mode**, choose **Load unpacked**,
and select the generated `dist/` directory.

Default shortcuts once loaded:

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+Shift+D` | Save the current tab |
| `Ctrl/Cmd+Shift+K` | Open the library |

Saving all open tabs to the inbox is deliberately left unbound — every remaining
`Ctrl+Shift+<letter>` is already spoken for by Chrome or by something you have installed.
Assign one at `chrome://extensions/shortcuts` if you want it.

## Develop

```bash
npm run dev            # Vite + HMR
npm run check          # isolation → permissions → tsc → unit tests → build → CSP
npm run e2e            # build, launch a headless browser, run the browser assertions
npm run tags:preview -- <export.html>   # what an import would produce; writes nothing
```

`npm run check` is the gate. Beyond typecheck, tests and build, it runs three guards:
`src/core/` stays free of Solid, DOM and `chrome.*` calls; every `chrome.*` namespace the
code touches is declared in the manifest; and the built bundle is free of `eval` and the
`Function` constructor.

The e2e suite drives a headless Chromium over the DevTools protocol. It must be launched
with `--password-store=basic` — without it the browser blocks forever on a system-keyring
prompt that never appears headlessly. `scripts/e2e/launch.sh` handles this.

`tags:preview` runs the real folder-tag rules over a real export and prints the resulting
tag set, the qualified splits, and everything dropped as noise, without touching
IndexedDB. Use it before changing `src/core/io/folder-tags.ts`.

## Privacy

The extension makes no outbound network requests. There are no `host_permissions` at all,
by design, so the install prompt never asks to read your data on any website — favicons
come from Chrome's own cache via the `favicon` permission. Your library lives in
IndexedDB on your machine and goes nowhere else. The `bookmarks` permission is read-only
and used once, for first-run import.

Backup and restore are JSON files you write and read yourself, from the sidebar.

## Your data stays out of this repository

A bookmark tree is personal data, and so are its folder names — employers, clients, course
codes, medical and financial interests. Exported URLs are worse: real browsing history,
and query strings holding live session identifiers. Two rules keep that out of git:

- **Exports are gitignored** (`bookmarks*.html`, `bookmarkguru-*.json`). Never commit one.
  Test fixtures are synthetic and live in `scripts/fixtures/`.
- **Rules naming your own folders live in `config/folder-rules.json`, also gitignored.**
  Only generic browser containers and date patterns ship in code. `npm run config` seeds
  the file from `config/folder-rules.example.json`, so a fresh clone builds.

Tests assert behaviour rather than content; folder names in them are abstract (`P1`,
`SHARED`).

## Stack

Solid.js and TypeScript, built with Vite and CRXJS. Storage is IndexedDB via `idb`, behind
a repository interface. Search is an in-memory scan with word-start matching — no index to
build, persist, or keep in sync. Styling is plain CSS driven by one token file.

Runtime dependencies are `solid-js` and `idb`.

[PROGRESS.md](PROGRESS.md) is the full spec: architecture, data model, the search matching
rule, the folder→tag pipeline, and a catalogue of gotchas that each cost real debugging
time.

## License

[MIT](LICENSE)
