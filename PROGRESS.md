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

**UI scale lives in one token.** `--scale` in `tokens.css` drives every type size, control
height, gap and pane width; `1` is the original desktop density. Change that one number and
rebuild — do not scale fonts alone, or text outgrows the controls around it.

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

7. **The tags `name` index must not be unique.** Parent-qualified tags deliberately share
   a name: a general tag and each of its qualified variants are separate records with the
   *same* `name`, distinguished by id and `parent`. A unique index makes the **second**
   `putTags` throw `ConstraintError`, which surfaces partway through an import as a
   half-written library rather than as an obvious failure. `DB_VERSION` was not bumped
   (nothing was live yet); if you have an older database, clear it once.

8. **A modifier class loses to the base class's `:hover`.** `.btn:hover` is (0,2,0) and
   `.btn--primary` is only (0,1,0), so hovering a primary button repainted it in
   `--hover` while its text stayed `--accent-fg` — white on near-white, about 1.05:1.
   A `filter` on the hover rule cannot rescue it; the modifier must restate `background`
   in its own `:hover`. Check any `--modifier` that sets a colour the base also sets.

9. **Reading a custom property back gives you its *token text*, not a pixel value.**
   `getPropertyValue('--row-h')` returns the literal string `calc(34px * 1.75)`, so
   `parseFloat` yields `NaN`. Custom properties substitute lazily; only laying an element
   out resolves them. `BookmarkList.tsx` measures a hidden probe element for exactly this
   reason. Getting it wrong is silent — CSS drew 59.5 px rows while the windowing
   arithmetic used a 34 px fallback, so rows overlapped and the scrollbar lied.

10. **The HTML importer cannot use `DOMParser`.** `src/core/` may not touch the DOM, so
   `html-import.ts` parses Netscape HTML with regex over lines. That is not a compromise:
   the format is machine-generated, one tag per line, and `</DL>` counting is the only
   sound way to track depth since indentation is not reliable and `<DT>` has no close tag.

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
    io/folder-tags.ts       shared noise filters + tag qualification — the rules
    io/ingest.ts            RawEntry[] → records: dedupe, tag union, status routing
    io/chrome-import.ts     live bookmark tree → RawEntry[]
    io/html-import.ts       exported .html → RawEntry[] (regex, never DOMParser)
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
npm run check          # isolation → permissions → tsc → 90 tests → build → CSP
npm run e2e            # build, launch headless browser, run 19 browser assertions
npm run build          # → dist/, load unpacked at chrome://extensions
npm run dev            # Vite + HMR
npm run tags:preview -- <export.html>   # what an import would produce. Writes nothing.
```

Both `check` and `e2e` are green as of this commit.

`tags:preview` is the loop for tuning folder-tag rules: it runs the real rules over a real
export and prints the tag set, the qualified splits, and everything dropped as noise,
without touching IndexedDB. Use it before any change to `folder-tags.ts`.

---

## What Phase 1 delivers

Import your Chrome bookmarks (folders → tags, duplicates collapsed with tags unioned,
`chrome://` skipped), browse a virtualized list, substring-search, select a row and read
its detail, save the current tab from the popup with tags and already-saved detection,
browse in the side panel, and **activate a bookmark to focus the tab that already has it
open** rather than opening a duplicate.

---

## Folder→tag rules

Derived by running candidate rules over a large real export and reading the output, then
encoding what survived. **The corpus itself is not in this repository and neither are its
folder names** — see "Personal data" below. Reproduce the analysis on your own export with
`npm run tags:preview`.

The finding worth carrying: the folder tree is a good tag source once noise is removed, and
the failure mode is not missing tags but *silently merged* ones.

### Noise classification

Folders describe filing as often as subject matter. Five classes, in `folder-tags.ts`:

| Class | Source | Behaviour |
|---|---|---|
| `structural` | shipped defaults + config | dropped, not a tag |
| `session` | **config only** | dropped, and contents import as `status: 'inbox'` |
| `date` | shipped patterns | dropped |
| `course-day` | shipped pattern | dropped |
| `keep` | everything else | becomes a tag |

Three things here are easy to get wrong:

- **Date names come in at least three shapes** — ISO, `M-D-YY` embedded in a longer name,
  and `MonDDYYYY`. One pattern silently misses the others. The month-name form is anchored
  to real month abbreviations; a bare `[A-Z][a-z]{2}\d+` also swallows `Win10`, `Mac11`,
  `Gen8` and deletes those tags.
- **Course-day dividers appear in both spellings**, `Day 1` and `Day1`, often in one export.
- **There is deliberately no name-length rule.** "Drop names of two characters or fewer"
  reads as obvious hygiene and destroys real tags — short names are exactly what languages
  and tools have. This was tried. A test asserts classification is length-independent.

Unrecognised names classify as `keep`. The rules fail open, because the cost of a junk tag
is a cluttered sidebar and the cost of over-matching is deleted data.

### Qualify ambiguous names — never merge them

Deriving a tag id from the name alone fuses every folder that shares a name. Two folders
called `Tools` under different parents are usually not the same subject, and once they
share an id **nothing in the record says they were ever separate**. Merging is a one-way
door.

So import emits both:

```
P1/SHARED  →  P1, SHARED, P1·SHARED
P2/SHARED  →  P2, SHARED, P2·SHARED
```

The qualified tag preserves the distinction; the general tag preserves the broad grouping.
Nothing is lost either way, and no "are these really the same thing?" judgement is made at
import time — that judgement belongs in the tag-merge UI, where a human can see what is
being joined.

**Every name with more than one parent qualifies, not a curated subset.** A hand-picked
list of "the genuinely ambiguous ones" re-introduces exactly the judgement this avoids, and
is silently wrong for the next name. Uniformity costs a few qualified tags nobody needed,
where only the filing location differed rather than the meaning. Those are visible and one
merge click each; a wrong silent merge is not recoverable.

**Qualification does not cascade.** Only names that are actually ambiguous get a qualified
form; unambiguous ancestors and children stay flat. Full-path qualification was considered
and rejected — it multiplies the tag count and pushes many records to 6–8 tags, which no
chip UI survives.

**Ambiguity is computed on filtered paths, and the order matters.** Two *different* noise
parents reduce to the same position once filtering runs, so their shared child is not
ambiguous. Computing ambiguity on raw paths over-reports substantially.

### `Tag.parent`

A qualified tag keeps the plain name and points at its qualifying folder:

```ts
{ id: 'tag:p1/shared', name: 'SHARED', parent: 'tag:p1' }
```

`parent` is a tag **id**, so renaming the general tag never orphans its children. The
sidebar nests qualified tags under their general one and chips render `P1 · SHARED`.

⚠️ This is why the tags `name` index must not be unique — see gotcha #7.

### Saved tab sets are a status problem, not a tag problem

A folder full of "the tabs I had open that day" is a triage queue, not library material.
Session folders drop their name, route contents to `status: 'inbox'`, and record the
capture date in `source.sessionDate` — deliberately not `importedAt`, since a tab set
captured years ago and imported today has two different, both useful, dates.

**Dedupe promotes out of the inbox.** When the same URL also appears in an ordinary folder,
the record becomes `active`: being deliberately filed outranks having been open in a tab.
Without this the result depends on where a URL happens to appear in the file, which is not
a property anyone can reason about.

Do not re-route session records to `active` wholesale to make them visible sooner — that is
how stale session records permanently dilute the default list. They are already reachable
through the sidebar's Inbox view.

### Where the rules live

```
core/io/folder-tags.ts    noise classification + qualification. Pure. The rules.
core/io/ingest.ts         RawEntry[] → records: dedupe, tag union, status routing.
core/io/chrome-import.ts  live chrome.bookmarks tree → RawEntry[]. Roots by node id.
core/io/html-import.ts    exported .html → RawEntry[]. Roots by PERSONAL_TOOLBAR_FOLDER.
```

Parsers read a format and stop. Root detection is the only thing that legitimately differs
between them — node ids exist in the live API and not in an export. Everything downstream
is shared, because a rule list this long would otherwise drift between two copies.

### Weaker tag sources, measured and mostly rejected

- **URL path extraction does not generalise.** On a broad library the top domain still
  spreads across hundreds of distinct path segments, most appearing once. Auto-tagging by
  path manufactures roughly as many tags as it covers records.
- **Title suffixes are thin.** Many titles carry a `·`/`|`/`-` delimiter, but a large share
  of the extracted suffixes merely restate the domain, which is already a field. The useful
  remainder is a long tail — a supplement, never a primary source.
- **Co-occurrence inference works, but only after import.** Domains with several bookmarks
  frequently have one dominant tag, which predicts the rest well. It is a good suggestion
  engine for untagged records — and it only works *because* the folder import supplied the
  labels it learns from. Build it second.

### Personal data

**A bookmark tree is personal data, and so are its folder names.** They carry employers,
clients, course codes, medical and financial interests, and hobbies. Exported URLs are
worse: real browsing history, and query strings holding live session identifiers.

Three rules, all enforced rather than remembered:

1. **`bookmarks*.html` is gitignored.** Never commit an export. Fixtures are synthetic and
   live in `scripts/fixtures/`.
2. **Rules that name personal folders live in `config/folder-rules.json`, gitignored.**
   Only generic browser containers and format patterns ship in code. No session names ship
   at all — everyone invents their own word for a tab dump, so guessing would be wrong more
   often than right. `npm run config` seeds the file from the committed example so a fresh
   clone builds. See `config/folder-rules.example.json`.
3. **Tests assert behaviour, not content.** Folder names in tests are abstract (`P1`,
   `SHARED`). Content-shaped tests pull toward realistic examples, and realistic examples
   come from a real tree — which is how personal names end up in a repository. Where a
   literal genuinely *is* the rule (date shapes, shipped container names) the test iterates
   the exported list instead of hand-picking.

---

## Next: Phase 2

Roughly in order:

1. **Wire MiniSearch.** `minisearch` is installed but unused. Build the index in
   `core/search/index-builder.ts`, pass a `scores` map into the existing `runQuery` —
   the pipeline already accepts one and already handles relevance sort. Cache the
   serialized index in the `meta` store so cold start hydrates instead of reindexing.
2. **Tag CRUD** — rename, recolour, merge, delete. Bookmarks store tag *ids*, so renaming
   must not rewrite records. **Merge is the important one**: import deliberately
   over-produces qualified tags (see Tier 2 above) and leaves collapsing them to this UI,
   where the user can see what is being combined. Merge must be user-driven, never
   inferred.
3. **Filter sidebar** — domain filter, favourites, multi-tag any/all. `Filters` already
   supports all of it; the UI does not expose it yet.
4. **Favicons** — `Favicon.tsx` exists and works; wire it into more surfaces.
5. **Triage mode** — see below. Supersedes the planned `InboxTriage.tsx` and absorbs the
   Phase 3 bulk-actions item.
6. **Open-tab import → inbox.** Capture all tabs across all 7 windows in one
   `chrome.tabs.query({})`, convert tab groups and window numbers to tags, land everything
   as `status: 'inbox'`. `status` and `SourceMeta.windowId/tabGroup` already exist in the
   schema for this. Also ship it as a standing "Save all open tabs" command.

Phases 3–4 (collections, saved searches, dedupe review, HTML/JSON export) are in
`~/.claude/plans/create-a-plan-for-compressed-beaver.md`.

---

## Triage mode

**Decided.** Replaces `InboxTriage.tsx`, which was scoped to the inbox for no good reason.

**It operates on `library.visible()` — the current query result — not on a status.** The
inbox is only a filter (`status: ['inbox']`), so acting on the result set instead makes the
same component handle the inbox, everything on a dead domain, everything tagged for a
finished course, everything older than 2015, or any search. Restricting it to one status
buys nothing and costs a second implementation later.

Cheap to build because it needs **no multi-select**: `selectedId` is already a single
signal, and a keep/discard pass is inherently single-record stepping — decide, cursor
advances. It is a keyboard mode over the existing list, not a new view.

### Three actions, and discard is contextual

```
keep      inbox → active                    (leaves the queue)
          active/archived → unchanged       (confirms, advances)

discard   inbox    ──▶ archived
          active   ──▶ archived
          archived ──▶ deleted, permanently

skip      status unchanged, cursor advances
```

**`skip` is why nothing needs remembering.** "Decide later" is its own action, so `undiscard`
never has to restore a previous status — it always returns a record to `active`. In both
real cases that is right: you over-archived from the library (was active, returns active),
or you archived from the inbox and changed your mind (you have now looked at it twice; it
is a keeper). Restoring to `inbox` would push it back into a queue you already cleared.

### The Archive view is the only destructive surface in the app

Discarding an archived record deletes it, and `removeBookmark` writes straight through to
IndexedDB with no recovery. A held-down key in a fast flow over the Archive destroys
records permanently.

**Undo is therefore a prerequisite for triage mode, not a follow-up.** A session-scoped
stack of recent actions is enough — nothing syncs, there is one user, and the records are
small enough to hold in memory. Build it with the mode, not after.

This matters most for imported library records. A long-lived bookmark tree accumulates
dead links and stale interests, so a fast pass over it is exactly what you will want to
run — and exactly where an unrecoverable mistake would hurt.

---

## Known gaps

- Search is substring-only until MiniSearch is wired.
- No triage mode yet, so pruning is one record at a time through the detail pane. Imported
  session records are browsable via the sidebar's Inbox view — what is missing is the fast
  pass, not access. See "Triage mode" above.
- **No undo, anywhere.** `removeBookmark` writes straight through to IndexedDB. Tolerable
  while deletion is a deliberate one-at-a-time act; a blocker for triage mode.
- No tag CRUD, so a qualified tag that turns out to be redundant cannot
  be merged away yet. Import over-produces on purpose; the merge UI is the other half.
- Sidebar shows status views and tags; domain/favourite filters are not exposed.
- No collections, saved searches, bulk actions, or dedupe review UI yet.
- No HTML or JSON import/export yet — **JSON backup is the only safe way to preserve
  notes and tags, so build it before relying on the library.**
- Favicon coverage is partial by design: only URLs Chrome has already cached.
- `eslint-plugin-solid` is not set up; gotcha #5 is enforced by discipline for now.
