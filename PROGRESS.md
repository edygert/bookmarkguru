# BookmarkGuru — progress and handoff

**Status: Phase 1 complete and runtime-verified.** Loadable, usable extension.

---

## What this is

A Chrome MV3 extension that replaces the bookmark manager with a **personal link
database**: search-first, tag-based, collection-driven, with tab awareness.

**The product principle, which drives most design decisions:** this is not "Chrome
bookmarks with a nicer tree." Chrome's bookmark tree is an import/export bridge only —
never the live data model, never the primary UI. On import, **folders become tags**, so
a link filed in one place becomes findable by any of its attributes.

---

## Stack

| Area | Choice | Why |
|---|---|---|
| Framework | Solid.js 1.9 | ~7 kB, no VDOM; fine-grained reactivity removes the memo/dependency-array maintenance category |
| Language | TypeScript, strict | Solid needs a compiler for JSX anyway, so types are free |
| Build | Vite 8 + `vite-plugin-solid` + `@crxjs/vite-plugin` | CRXJS generates the manifest and bundles the worker |
| Storage | IndexedDB via `idb`, behind a repository interface | Per-record writes and real indexes; `chrome.storage.local` rewrites the whole collection per write |
| Search | MiniSearch (installed, **not yet wired** — Phase 2) | Inverted index, incremental updates, serializable |
| Styling | Plain CSS + custom properties | Zero deps, one token file drives light/dark and density |
| Virtual list | Hand-rolled (~45 lines) | See gotcha #3 |

Runtime deps: `solid-js`, `idb`, `minisearch`. That's it.

---

## Hard-won gotchas — read before changing anything

These each cost real debugging time. None were caught by `tsc`, vitest, or the build.

1. **`manager.html` must be an explicit Rollup input.** CRXJS only builds HTML declared
   in the manifest. The manager opens programmatically via `chrome.runtime.getURL`, so
   without `build.rollupOptions.input` in `vite.config.ts` it silently is not built.

2. **Two URL normalizations exist and must not be mixed.**
   `normalizeForDedupe` strips fragments and tracking params (for the stored
   `normalizedUrl`, dedupe, indexing). `normalizeForMatch` keeps them (for open-or-switch
   and the open-now badge). Comparing one against the other means the badge almost never
   fires *and* contradicts what clicking does. Use `library.isOpen(bookmark)`.

3. **`@tanstack/solid-virtual` did not work here** and was removed. Its signal-backed
   `totalSize` updated correctly while its store-backed `virtualItems` stayed empty — the
   container got the right height and rendered zero rows. Removing it also halved the
   main bundle (45.3 kB → 21.2 kB). `BookmarkList.tsx` now owns the windowing; rows are a
   fixed 34 px (`--row-h`), which is what makes that simple.

4. **A `chrome.*` namespace used without its manifest permission silently kills the
   service worker.** The namespace is `undefined`, `.addListener` throws during module
   evaluation, and registration fails with *no* error surfaced anywhere. `@types/chrome`
   declares the full API regardless of the manifest, so `tsc` is no help. This shipped
   once (`contextMenus`) and cost a long bisect. `npm run guard:permissions` now catches it.

5. **Solid reactivity fails silently.** Never destructure props (`props.bookmark`, not
   `const { bookmark } = props`); use `<For>`/`<Show>` rather than `.map()`/ternaries in
   anything that re-renders. Components run once — per-update logic goes in `createMemo`
   or JSX expressions, never the component body.

6. **`--password-store=basic` is required** when launching the browser headlessly, or it
   blocks forever on a keyring prompt that never appears.

---

## Architecture

```
SURFACES (page contexts — own all IDB writes)
  manager.html · panel.html · popup.html      Solid components + stores
        │ reads/writes                ▲ change broadcasts
        ▼                             │
src/core/  — framework-agnostic engine (plain TS, no Solid / DOM / chrome.*)
  repository · search · normalize · match · io
        ▼
   IndexedDB  (bookmarks, tags, collections, savedSearches, meta)

background/service-worker.ts
  open-or-switch · commands · context menus · side-panel wiring
```

**Two structural rules:**

- **`src/core/` never imports Solid, touches the DOM, or calls `chrome.*`.** It takes and
  returns plain data. This keeps the engine testable in plain node and the view layer
  replaceable. Enforced by `npm run guard:isolation`.
- **Page contexts own IndexedDB writes, not the service worker.** MV3 terminates idle
  workers after ~30 s, which would corrupt a long import. Long work (import, dedupe,
  reindex) runs in the manager page. The worker does only short event-driven work — plus
  the single atomic open-count bump, which lives there because the popup closes the
  instant it is clicked.

---

## File map

```
manifest.config.ts          CRXJS manifest (permissions live here)
vite.config.ts              note the explicit manager.html input
scripts/
  guard-isolation.mjs       core/ must stay framework-free
  guard-permissions.mjs     every chrome.* namespace must be declared
  guard-csp.mjs             no Function-constructor/eval in dist/
  e2e/                      browser-driven verification — see its README
src/
  core/                     ← NO Solid, NO DOM, NO chrome.*
    types.ts                Bookmark, BookmarkStatus, Tag, Collection, SavedSearch
    normalize-url.ts        the two normalizations + isIngestable + domainOf
    tags.ts                 TagCollector, colour mapping
    db/                     schema.ts · repository.ts (interface) · idb-repository.ts
    search/query.ts         text → filter → sort pipeline (substring today)
    tabs/match.ts           extensible matching strategy list
    io/chrome-import.ts     bookmark tree → records, folders → tags
  shared/messages.ts        typed message contracts
  background/service-worker.ts
  ui/
    App.tsx                 shared shell; `compact` collapses to one column
    state/library.ts        the ONLY place Solid meets the repository
    components/             Sidebar · BookmarkList · BookmarkRow · DetailPane · …
    styles/tokens.css       design tokens — read the header comment
    manager|panel|popup .html/.tsx
```

---

## Design language

Two deliberate choices carry the identity; both are documented in `tokens.css`.

- **The domain leads each row, in monospace**, ahead of the title. Every other bookmark
  manager does the reverse. When hunting thousands of links you recall the domain first
  ("it was on docs.rs… no, github"), so that is where the eye should land. Monospace is
  the subject's vernacular: the URL bar, the terminal.
- **Amber is reserved exclusively for "open in a tab right now."** Knowing that is the
  one thing Chrome's manager cannot do, so it gets the only saturated colour in the UI.
  Indigo handles selection; everything else is slate. Do not spend amber on anything else.

---

## Commands

```bash
npm install
npm run check     # isolation → permissions → tsc → 48 tests → build → CSP
npm run e2e       # build, launch headless browser, run 19 browser assertions
npm run build     # → dist/, load unpacked at chrome://extensions
npm run dev       # Vite + HMR
```

Both `check` and `e2e` are green as of this commit.

---

## What Phase 1 delivers

Import your Chrome bookmarks (folders → tags, duplicates collapsed with tags unioned,
`chrome://` skipped), browse a virtualized list, substring-search, select a row and read
its detail, save the current tab from the popup with tags and already-saved detection,
browse in the side panel, and **activate a bookmark to focus the tab that already has it
open** rather than opening a duplicate.

---

## Next: Phase 2

Roughly in order:

1. **Wire MiniSearch.** `minisearch` is installed but unused. Build the index in
   `core/search/index-builder.ts`, pass a `scores` map into the existing `runQuery` —
   the pipeline already accepts one and already handles relevance sort. Cache the
   serialized index in the `meta` store so cold start hydrates instead of reindexing.
2. **Tag CRUD** — rename, recolour, merge, delete. Bookmarks store tag *ids*, so renaming
   must not rewrite records.
3. **Filter sidebar** — domain filter, favourites, multi-tag any/all. `Filters` already
   supports all of it; the UI does not expose it yet.
4. **Favicons** — `Favicon.tsx` exists and works; wire it into more surfaces.
5. **Open-tab import → inbox.** The headline Phase 2 feature: capture all tabs across all
   7 windows in one `chrome.tabs.query({})`, convert tab groups and window numbers to
   tags, land everything as `status: 'inbox'`, and build `InboxTriage.tsx` for the
   keep/discard pass. `status` and `SourceMeta.windowId/tabGroup` already exist in the
   schema for this. Also ship it as a standing "Save all open tabs" command.

Phases 3–4 (collections, saved searches, bulk actions, dedupe review, HTML/JSON
import-export) are in `~/.claude/plans/create-a-plan-for-compressed-beaver.md`.

---

## Known gaps

- Search is substring-only until MiniSearch is wired.
- Sidebar shows status views and tags; domain/favourite filters are not exposed.
- No collections, saved searches, bulk actions, or dedupe review UI yet.
- No HTML or JSON import/export yet — **JSON backup is the only safe way to preserve
  notes and tags, so build it before relying on the library.**
- Favicon coverage is partial by design: only URLs Chrome has already cached.
- `eslint-plugin-solid` is not set up; gotcha #5 is enforced by discipline for now.
