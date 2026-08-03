# BookmarkGuru — spec and handoff

Chrome MV3 extension replacing the bookmark manager with a personal link database:
search-first, tag-based, tab-aware.

**Status:** Phase 1 and 2 complete and runtime-verified. `npm run check` and `npm run e2e`
are green as of this commit.

**Product rule:** Chrome's bookmark tree is an import bridge only — never the live data
model, never the primary UI, and nothing exports back to it. On import, folders become
tags, so a link filed in one place is findable by any of its attributes.

---

## TODO

Remaining work, highest value first. Nothing here is started.

| # | Item | Notes |
|---|---|---|
| 1 | Duplicate detection and merge review | Nothing exists yet. Dedupe today is exact-key only, at write time: `ingest` collapses repeats within one import, `runImport` skips URLs already stored. Neither finds near-duplicates already in the library — `http`/`https`, `www.`, a trailing slash, `index.html`, a mobile host, or non-tracking query params all produce separate records. |
| 2 | Command bar | Unspecified. Intended as ⌘K over one box: jump to a record, switch view, run import/export/triage. Spec it or drop it. |
| 3 | `eslint-plugin-solid` | Gotcha #5 is enforced by discipline only. |
| 4 | Component tests | Zero tests under `src/ui/`; every UI claim rests on the e2e scripts. |

---

## Stack

| Area | Choice | Why |
|---|---|---|
| Framework | Solid.js 1.9 | ~7 kB, no VDOM; fine-grained reactivity removes the memo/dependency-array maintenance category |
| Language | TypeScript, strict | Solid needs a compiler for JSX anyway |
| Build | Vite 8 + `vite-plugin-solid` + `@crxjs/vite-plugin` | CRXJS generates the manifest and bundles the worker |
| Storage | IndexedDB via `idb`, behind a repository interface | Per-record writes and real indexes; `chrome.storage.local` rewrites the whole collection per write |
| Search | In-memory scan, word-start matching | No index to build, persist or keep in sync |
| Styling | Plain CSS + custom properties | One token file drives light/dark and density |
| Virtual list | Hand-rolled, ~45 lines | Gotcha #3 |

Runtime dependencies: `solid-js`, `idb`.

`--scale` in `tokens.css` drives every type size, control height, gap and pane width; `1`
is the original desktop density. Scaling fonts alone makes text outgrow its controls.

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
   IndexedDB  (bookmarks, tags, meta)

background/service-worker.ts
  open-or-switch · commands · context menus · side-panel wiring
```

Two structural rules:

- **`src/core/` never imports Solid, touches the DOM, or calls `chrome.*`.** It takes and
  returns plain data, which keeps the engine testable in plain node and the view layer
  replaceable. Enforced by `npm run guard:isolation`.
- **Page contexts own IndexedDB writes, not the service worker.** MV3 terminates idle
  workers after ~30 s, which would corrupt a long import. Import, dedupe and reindex run
  in the manager page. The worker does short event-driven work only, plus the atomic
  open-count bump — that lives there because the popup closes the instant it is clicked.

### File map

```
manifest.config.ts          CRXJS manifest (permissions and icons)
public/icons/               generated PNGs; Vite copies public/ to the bundle root
scripts/make-icons.py       icon source — edit this, not the PNGs
vite.config.ts              note the explicit manager.html input (gotcha #1)
scripts/
  guard-isolation.mjs       core/ must stay framework-free
  guard-permissions.mjs     every chrome.* namespace must be declared. Greps text, so
                            naming one in a comment fails the build — reword, do not
                            weaken the guard
  guard-csp.mjs             no Function-constructor/eval in dist/
  e2e/                      browser-driven verification — see its README
src/
  core/                     ← NO Solid, NO DOM, NO chrome.*
    types.ts                Bookmark, BookmarkStatus, Tag, Filters, BackupPayload
    normalize-url.ts        the two normalizations + isIngestable + domainOf
    tags.ts                 TagCollector, generalTagId, findNameConflict, retag
    db/                     schema.ts · repository.ts (interface) · idb-repository.ts
    search/query.ts         text → status → sort. Text is the only narrowing there is
    tabs/match.ts           extensible matching strategy list
    io/folder-tags.ts       noise classification + tag qualification — the rules
    io/ingest.ts            RawEntry[] → records: dedupe, tag union, status routing
    io/chrome-import.ts     live bookmark tree → RawEntry[]
    io/html-import.ts       exported .html → RawEntry[] (regex, never DOMParser)
    io/tabs-import.ts       open tabs → RawEntry[] (sourceTags, no folder path)
    io/json-backup.ts       records ⇄ JSON string. NOT an importer — bypasses ingest
  shared/messages.ts        typed message contracts
  background/service-worker.ts
  ui/
    App.tsx                 shell: sidebar | list over detail. `compact` drops both
    state/library.ts        the ONLY place Solid meets the repository
    components/             Sidebar · VirtualList · BookmarkList · TabList · TagList ·
                            DetailPane · TabDetail · TagDetail · …
    styles/tokens.css       design tokens — read the header comment
    manager|panel|popup .html/.tsx
```

### Data model

`Bookmark`: `id`, `url`, `normalizedUrl`, `domain`, `title`, `description`, `tags` (ids),
`createdAt`, `updatedAt`, `lastOpenedAt`, `openCount`, `status`, `source`. **No notes
field** — a tag says why a link is worth keeping, and the room the editor took is the room
the chips needed.

`Tag`: `id`, `name`, and `parent` on a qualified variant. Nothing else — no colour.

`Filters`: `status` (default `['active']`) — the view — plus `tag`, a tag **id** the Tags
view drills into. `domain` stays a field on the record: it is the second line of every row
and a sort option, but nothing filters on it.

IndexedDB v1, `SCHEMA_VERSION` 1. Stores: `bookmarks`, `tags`, `meta`. Indexes on
`normalizedUrl`, `domain`, `createdAt`, `updatedAt`, `lastOpenedAt`, `status`, and `tags`
(`multiEntry`); `tags.name` is indexed and **not unique** (gotcha #7). Only
`normalizedUrl` is queried by index — everything else loads via `getAll()` and filters in
memory.

---

## Commands

```bash
npm install
npm run check          # isolation → permissions → tsc → 168 tests → build → CSP
npm run e2e            # build, launch headless browser, run 163 browser assertions
npm run build          # → dist/, load unpacked at chrome://extensions
npm run dev            # Vite + HMR
npm run tags:preview -- <export.html>   # what an import would produce. Writes nothing.
```

`tags:preview` runs the real folder-tag rules over a real export and prints the tag set,
the qualified splits and everything dropped as noise, without touching IndexedDB. Use it
before any change to `folder-tags.ts`.

---

## Gotchas

Each cost real debugging time. None were caught by `tsc`, vitest, or the build.

1. **`manager.html` must be an explicit Rollup input.** CRXJS only builds HTML declared in
   the manifest. The manager opens via `chrome.runtime.getURL`, so without
   `build.rollupOptions.input` in `vite.config.ts` it is silently not built.

2. **Two URL normalizations exist and must not be mixed.** `normalizeForDedupe` strips
   fragments and tracking params, for the stored `normalizedUrl`, dedupe and indexing.
   `normalizeForMatch` keeps them, for open-or-switch and the open-now badge. Comparing one
   against the other makes the badge almost never fire and contradicts what clicking does.
   Use `library.isOpen(bookmark)`.

3. **`@tanstack/solid-virtual` did not work here** and was removed. Its signal-backed
   `totalSize` updated while its store-backed `virtualItems` stayed empty: right container
   height, zero rows. Removal halved the main bundle, 45.3 kB → 21.2 kB. `VirtualList.tsx`
   owns the windowing; rows are a fixed `--row-h`, which is what makes that simple.

4. **A `chrome.*` namespace used without its manifest permission silently kills the service
   worker.** The namespace is `undefined`, `.addListener` throws during module evaluation,
   and registration fails with no error surfaced anywhere. `@types/chrome` declares the full
   API regardless of the manifest. Shipped once (`contextMenus`); `npm run guard:permissions`
   now catches it.

5. **Solid reactivity fails silently.** Never destructure props — `props.bookmark`, not
   `const { bookmark } = props`. Use `<For>`/`<Show>`, not `.map()`/ternaries, in anything
   that re-renders. Components run once; per-update logic goes in `createMemo` or a JSX
   expression, never the component body.

6. **`--password-store=basic` is required** when launching the browser headlessly, or it
   blocks forever on a keyring prompt that never appears.

7. **The tags `name` index must not be unique.** A general tag and each of its qualified
   variants are separate records with the same `name`, distinguished by id and `parent`. A
   unique index makes the *second* `putTags` throw `ConstraintError`, surfacing partway
   through an import as a half-written library. `DB_VERSION` was never bumped for this, nor
   when the `collections` and `savedSearches` stores were dropped — clear the database once
   if you have a build predating either.

8. **A modifier class loses to the base class's `:hover`.** `.btn:hover` is (0,2,0) and
   `.btn--primary` is (0,1,0), so hovering a primary button repainted it in `--hover` while
   its text stayed `--accent-fg` — about 1.05:1. A `filter` on the hover rule cannot rescue
   it; the modifier must restate `background` in its own `:hover`. Check any `--modifier`
   setting a colour the base also sets.

9. **Reading a custom property back gives its token text, not a pixel value.**
   `getPropertyValue('--row-h')` returns the literal `calc(34px * 1.75)`, so `parseFloat`
   yields `NaN`. Only laying an element out resolves them, which is why `VirtualList.tsx`
   measures a hidden probe. Getting it wrong is silent: CSS drew 59.5 px rows while the
   windowing arithmetic used a 34 px fallback, so rows overlapped and the scrollbar lied.

10. **The HTML importer cannot use `DOMParser`,** since `src/core/` may not touch the DOM.
    `html-import.ts` parses Netscape HTML with regex over lines. The format is
    machine-generated, one tag per line, and `</DL>` counting is the only sound way to
    track depth: indentation is unreliable and `<DT>` has no close tag.

11. **Never hand a Solid store value to IndexedDB.** `createStore` returns proxies and
    structured clone cannot clone one; `put` throws `"#<Object> could not be cloned"`,
    which `runImport` catches and renders as a generic banner with every count reading
    zero. **A one-level spread is not the fix** — `{ ...current, ...patch }` leaves nested
    `tags` and `source` proxied and throws `"[object Array] could not be cloned"`. Use
    `unwrap(current)` at the store→repository boundary.

    Both failures were near-invisible. The first only fires on the *second* write, because
    the first import runs against an empty store where no proxy is ever passed along. The
    second is quieter still: `patchLocal` has already run, so the list, cursor and detail
    pane show the new value while nothing reaches IndexedDB and the record reverts on
    reload. Caught by `tabs-test.mjs` and `triage-test.mjs`, which read back out of
    IndexedDB rather than trusting the DOM.

12. **A count next to a control must be the count that control produces.** The sidebar
    showed `openUrls().size` — open browser *tabs* — beside a control that filtered
    *bookmarks*, reading "171" and delivering an empty list. Both are plausible integers;
    neither `tsc` nor a unit test can tell them apart. Hence the capture button's count
    excludes browser-internal tabs and dedupes by normalized URL, and the tag view's
    `tagUsage` counts all three statuses because it sits beside a Delete that touches all
    three. Where a control genuinely cannot deliver a count, the label says what it does
    instead: the tag view's jump reads `Search for "<name>"`, because it runs a text search
    that also matches titles and URLs.

13. **Anything derived from a tag's *name* breaks when renaming ships.** The sidebar found
    a qualified tag's general form with `tagIdFromName(tag.name)`, which held only because
    import generates both names from the same folder. After a rename the row does not move
    — it vanishes: the tag still has a `parent` so it is excluded from the roots, and no
    root's id matches its new name. `generalTagId()` derives it from the id instead. Same
    rule as why a tag's id keeps its original text (`tag:tools` may display "Rust"): ids
    are identity, names are display.

14. **Every list row is a `div role="option"`, never a `<button>`.** Rows host controls —
    the tab view's Save, the tag chips' remove — and a button inside a button is invalid;
    `role="option"` is also the correct child of the container's `role="listbox"`. Three
    rules follow, none visible to `tsc` or a DOM assertion:

    - **A row must not handle `Enter`.** `VirtualList` binds it on the container and the
      event bubbles, so a row handling it too activates twice. The only trace is
      `openCount` climbing in pairs, which is why `search-test.mjs` reads the counter out
      of IndexedDB.
    - **The container takes focus on click.** A row that cannot hold focus leaves focus on
      `<body>`, where `j`/`k`/`Enter` reach nothing.
    - **A nested control must `stopPropagation`,** or it moves the cursor as a side effect.

---

## Views

The sidebar is navigation. **Every control in it replaces the list or acts on the whole
library; nothing in it narrows.** Narrowing is the search box, which matches `title`,
`url`, `description` and tag *names*.

| Control | Kind | Notes |
|---|---|---|
| Library · Inbox · Archive | view | `status` is one field per record, so these partition the library |
| Open tabs | view | lists tabs, including ones that are not records |
| Tags | view | lists tags, including ones on no records; drills into a tag's records |
| tag scope chip | state, in the toolbar | shows what the Tags view drilled into; clicking it leaves |
| Delete, on a tag row | action | opens a dialog naming the links it would strip |
| Import from Chrome · Import a file | action, own group | see "Importing" |
| Export · Restore | action, own group | not `nav-item`: anything wearing that class in this pane reads as selectable |

There is no tag list, domain list or `Open now` toggle, and none should be added: each
would be a second path to something the text match already does, kept in step for no gain.

**The one exception is the tag scope**, and it is not a control — it is where the Tags view
lands. `Show N links` sets `filters.tag` to a tag **id**, so the list is exactly the records
that row counted; a search for the name would also match titles and URLs and deliver
more rows than the button promised. While it is on, the toolbar shows the tag as a chip,
which is both the notice that the list is scoped and the way out of it. Switching view
clears it.

**`Open tabs` is a view because no search over the library can show a URL the database has
never seen,** and the interesting tabs are the unsaved ones. It lists every tab across
every window, marks the ones already saved, and offers to capture the rest.

**`Tags` is a view for the same reason one level up.** No search over records reaches a tag
that no record carries, so without this view untagging the last record would strand a tag
in IndexedDB with nothing able to rename or delete it. It is also the only tag surface:
renaming and deleting happen on its rows.

Double-clicking a row drills into that tag's records **by id**, so the count on the row is
the number of rows you land on.

### Capturing tabs

`Save N tabs` captures what the list is showing, search filter included. The
`save-open-tabs` command and the action's context menu capture everything. All of it lands
as `status: 'inbox'`.

- **The tab list shows the tags a capture would write, from `sourceTagsFor`** — the same
  function the capture path calls, so `TabDetail` cannot advertise a set that differs from
  what gets saved.
- **Tab groups and window numbers become tags via `sourceTags`, not `folderPath`.** The
  folder machinery would apply rules built for a filing tree: a group named `Feb03` drops
  as a date, and a group appearing in two windows splits into `Window 3 · Research` and
  `Window 5 · Research`. `SourceTag` means "a person typed this on purpose; leave it alone".
- **Window ordinals are computed over every open window,** then passed in. Left to default,
  capturing a filtered subset renumbers it.
- **The bulk write runs in the manager page, never the worker.** A few hundred tabs is
  precisely the write an idle-terminated worker kills halfway. The worker's job is to
  ensure a manager exists to hear the request — by message if one is open, by URL hash
  otherwise.

---

## Search

`runQuery` in `core/search/query.ts`, an in-memory scan over the loaded records. No index
exists anywhere.

**It is the only thing that narrows a list by hand** — the tag scope is a drill-down, not a
control. That makes two of the fields it scans load-bearing rather than convenient:

- **`url` is searched because it replaces the domain filter.** Typing `github.com` narrows
  to that host, and `rust-lang` reaches `docs.rust-lang.org` and `blog.rust-lang.org`
  together — which the old filter could not do, since it compared the full host exactly.
  Do not drop `url` from `matchesTerm` as redundant with the domain column.
- **Tag *names* are searched because they replace the tag filter,** and multi-term AND
  replaces the `all`/`any` switch: `rust-lang async` is a host and a tag in one string.

### Matching rule

A term matches at the **start of a word**: `post` finds "postgres" and "post-mortem", not
"compost". A query splits on whitespace and every term must match, not necessarily in the
same field — `rust async` finds a page titled "Async patterns" at doc.rust-lang.org.
Fields searched: `title`, `url`, `description`, and tag *names* via `tagNames`.

Three things in `hasTerm` are easy to get wrong:

- **A term opening with punctuation is exempt.** `.org` follows a letter everywhere it
  appears, so requiring a boundary would make it unmatchable rather than precise.
- **It keeps looking after a mid-word hit.** `cat` appears inside "concatenate" before it
  appears as a word; bailing on the first `indexOf` reports no match on a record that has
  one.
- **It loops `indexOf` rather than tokenizing.** A match costs one search plus one
  character test; tokenizing every field of every record on every keystroke costs more than
  the scan it replaces.

Matching inside a word is not supported: `ostgres` does not find "postgres". That is the
same rule that stops `cat` finding "duplicate".

### Why there is no index

A search engine uniquely provides **relevance ranking**, which is not wanted yet;
everything else it offers is answered more cheaply. An index must be built whenever a page
opens — it lives in page memory, so the manager and side panel each build their own — and
then kept in step with every write.

Storing it in `meta.searchIndex` avoids the rebuild and buys a worse failure. A cache would
be shared by contexts that are not: the popup writes straight to the repository without
going through `library.ts`, so it can change the database while contributing nothing to the
cache. A drifting index fails quietly by returning *fewer* results, and "not found" is
indistinguishable from "never saved it". Closing that needs a stored signature — record
count, newest `updatedAt`, a hash of tag names — checked on every load.

An inverted index on IndexedDB is the live option if ranking becomes a priority: a `terms`
array per record with a `multiEntry` index, the same mechanism `tags` uses, persistent for
free and immune to the caching problem. It puts derived data inside the records the JSON
backup carries, so the backup would have to strip it, and scoring would still be
hand-written.

The seam is in place: `SortField` keeps `relevance`, `QueryInput` keeps `scores`, and
`compare()` keeps its scoring branch. Nothing supplies scores.

---

## Triage

Three keys on the list, alongside `j`/`k`/`Enter`:

| Key | Effect | No-op when |
|---|---|---|
| `a` | `status → 'archived'` | already `archived` |
| `r` | `status → 'active'` | already `active` |
| `Delete` / `Backspace` | permanent delete | status is not `archived` |

**It is not a mode.** No `triageMode` signal, no enter or exit, no toggle. Every bookmark
view runs the same three transitions; what differs is only which keys turn out to be no-ops,
which follows from what is in the list rather than from per-view branching. Per view:
Library — `a`. Inbox — `a`, `r`. Archive — `r`, `Delete`.

**It operates on `library.visible()`, the current query result, not on a status.** The
inbox is only a filter, so acting on the result set makes the same keys handle the inbox,
a dead domain, a finished course's tag, or any search.

**No multi-select.** `selectedId` is a single signal. A status change drops the record out
of `visible()` on its own and the next row inherits the cursor's index; `landOn()` in
`BookmarkList.tsx` exists only to bring the selection along, so the detail pane shows the
record that took the place.

**There is no undo, and none is needed.** Archiving is the fast repeatable act and is
reversible with `r`. Deleting is a different key, on a different screen, over records that
had to be archived first, and is guarded on the **record's** status rather than the view's —
equivalent while `filters.status` holds one value, but jumping from a tag to its records
widens it to all three, and the per-record guard is the one that stays correct. Deletion is
still unrecoverable: `removeBookmark` writes straight through to IndexedDB. JSON backup is
the floor under it.

**Hints are per-view,** for the same reason counts are: the status bar advertises
`a archive` in the Library, `a archive · r keep` in the Inbox, `r restore · ⌫ delete` in the
Archive. A fixed line would promise `⌫ delete` where it does nothing.

---

## Tag editing

Rename and delete, on the row. Per-record add/remove is in the bookmark's detail pane.

**The `Tags` view is the whole surface — there is no tag detail pane.** Each row is two
lines: the name, with a `Delete` button at the right; then the usage, per status
(`12 library · 3 inbox · 1 archive`, non-zero segments only, `unused` at zero). The Tags
view renders no detail pane at all, so the list takes the full height.

| Action | How |
|---|---|
| rename | `e` on the row under the cursor, or click the name of the selected row |
| show its records | double-click the row, or `Enter` |
| delete | the row's `Delete`, or `⌫` — both open the confirmation dialog |

**The editor is one input, owned by the list.** `TagList` holds which row is editing, not
the row: a windowed row unmounts when it scrolls out of range, which would close an open
editor mid-rename. The input stops `keydown` from bubbling, or the list's own `j`/`k`
would move the cursor out from under it and `Enter` would drill into the records instead
of committing.

**Tags have no colour.** `colorForTag` derived one from the name, which conveys nothing the
label does not, and 315 tags over 9 colours cannot identify anything. Chips read as chips
from their border and monospace.

**Renaming writes no bookmark record.** `Bookmark.tags` holds ids, so a rename touches one
field on one tag record. Two consequences:

- A tag's id keeps its original text. `tag:tools` may display "Rust". Ids are never shown,
  and this is what makes a later re-import of the folder `Tools` feed the renamed tag
  rather than resurrecting a duplicate, since import joins on id.
- A rename onto a name already in use is **refused, not merged**. The check is scoped to
  tags with the same `parent`: qualified variants deliberately share a name with their
  general form and with each other (gotcha #7) and are still told apart on screen, because
  a qualified tag renders behind its parent's name. Two tags rendering identically is the
  unusable case.

**Deleting asks in a modal, and the modal names the cost.** Delete strips the tag from every
record and removes the tag; no bookmark is deleted. A native `<dialog>` opened with
`showModal` — focus trapping, Escape-to-close and the backdrop are the browser's — saying
how many links it will strip, with `Cancel` focused so a stray `Enter` cancels. The dialog
belongs to `TagList` for the same reason the editor does. **Records first, tag record
last** — a failure between
the two leaves records carrying a tag that still exists, which is untidy, where the reverse
leaves ids pointing at a deleted tag, which renders as nothing and matches no filter while
still occupying a slot on every record.

Deleting a general tag does **not** cascade to its qualified children. An orphan keeps its
qualifying folder in front of its name (`P1 · SHARED`), so it stays distinguishable from
the general tag it outlived.

**There is no merge; deleting stands in for it.** A qualified tag is always emitted
alongside its general form, so a record tagged `P1 · SHARED` already carries `SHARED`.
Deleting the redundant qualified tag loses nothing. That is the case import over-produces,
and the only one that arises: import cannot mint two independently-created tags meaning the
same thing, since ids derive from names.

**Adding a tag by hand cannot mint a duplicate.** The detail pane's add-tag box offers
existing tags with their record counts, and a `Create` option only when the typed name
resolves to no existing id. Since ids derive from names, "Rust" typed by hand and a folder
named `Rust` are the same tag by construction.

---

## Importing

One import, two sources: Chrome's live tree and exported bookmark files. Both parsers
produce `RawEntry[]` and feed the same `ingest`. The sidebar's `Import` group drives both and
is available at any time, not only on an empty library.

- **The file picker takes several files at once.** Each runs as its own `runImport`, in order,
  and each ends with `load()` — so a later file dedupes against what an earlier one just
  wrote. The first file to supply a URL keeps its title and tags.
- **Re-import is additive.** Records already in the library are left exactly as they are and
  only unseen `normalizedUrl`s are written. One click, no confirmation.
- **Progress is `library.importProgress()`:** a label plus `done`/`total`, `null` when idle.
  The bar renders only while records are being written; reading and parsing show the label
  alone. `runImport` yields to the event loop once before calling `ingest`, which is
  synchronous — without that the label never paints.
- **`ImportOutcome` is a summary or an error string**, never both and never an all-zero
  summary standing in for a failure. `added + alreadySaved + skipped` is the number of entries
  parsed, which distinguishes "no bookmarks in that file" from "nothing new" from a crash.
- **Import errors report beside the picker**, like restore errors, not in the banner over the
  list. `state.error` is for `load()` failures.

Measured on a real 4.8 MB export: 6,974 entries → 5,713 records, 315 tags (32 qualified), 331
routed to the inbox, 14 skipped, under a second.

## Folder→tag rules

Derived by running candidate rules over a large real export and encoding what survived.
**The corpus is not in this repository and neither are its folder names** — see "Personal
data". Reproduce with `npm run tags:preview`.

The failure mode is not missing tags but *silently merged* ones.

### Noise classification

Five classes, in `folder-tags.ts`:

| Class | Source | Behaviour |
|---|---|---|
| `structural` | shipped defaults + config | dropped, not a tag |
| `session` | **config only** | dropped, contents import as `status: 'inbox'` |
| `date` | shipped patterns | dropped |
| `course-day` | shipped pattern | dropped |
| `keep` | everything else | becomes a tag |

- **Date names come in at least three shapes** — ISO, `M-D-YY` embedded in a longer name,
  and `MonDDYYYY`. One pattern silently misses the others. The month-name form is anchored
  to real month abbreviations; a bare `[A-Z][a-z]{2}\d+` also swallows `Win10`, `Mac11` and
  `Gen8`.
- **Course-day dividers appear as both `Day 1` and `Day1`,** often in one export.
- **There is deliberately no name-length rule.** "Drop names of two characters or fewer"
  reads as hygiene and destroys real tags — short names are what languages and tools have.
  A test asserts classification is length-independent.

Unrecognised names classify as `keep`. The rules fail open: a junk tag costs a cluttered
sidebar, over-matching costs data.

### Qualification

Deriving a tag id from the name alone fuses every folder sharing that name, and once they
share an id nothing in the record says they were separate. So import emits both forms:

```
P1/SHARED  →  P1, SHARED, P1·SHARED
P2/SHARED  →  P2, SHARED, P2·SHARED
```

The qualified tag preserves the distinction, the general tag the broad grouping. No "are
these the same thing?" judgement is made at import time; that judgement is a human deleting
the qualified tag in the `Tags` view, with the record count on the button.

- **Every name with more than one parent qualifies, not a curated subset.** A hand-picked
  list re-introduces the judgement this avoids and is silently wrong for the next name.
  Uniformity costs a few qualified tags nobody needed, each one visible and one click to
  remove; a wrong silent merge is not recoverable.
- **Qualification does not cascade.** Only actually-ambiguous names get a qualified form.
  Full-path qualification multiplies the tag count and pushes many records to 6–8 tags,
  which no chip UI survives.
- **Ambiguity is computed on filtered paths, and the order matters.** Two different noise
  parents reduce to the same position once filtering runs, so their shared child is not
  ambiguous. Computing on raw paths over-reports substantially.

`Tag.parent` holds a tag **id**, so renaming the general tag never orphans its children:

```ts
{ id: 'tag:p1/shared', name: 'SHARED', parent: 'tag:p1' }
```

The sidebar nests qualified tags under their general one; chips render `P1 · SHARED`.

### Saved tab sets are a status problem, not a tag problem

Session folders drop their name, route contents to `status: 'inbox'`, and record the
capture date in `source.sessionDate` — not `importedAt`, since a tab set captured years ago
and imported today has two different useful dates.

**Dedupe promotes out of the inbox.** When the same URL also appears in an ordinary folder
the record becomes `active`: being deliberately filed outranks having been open in a tab.
Without this the result depends on where the URL happens to appear in the file.

Do not re-route session records to `active` wholesale — that is how stale session records
dilute the default list. They are reachable through the Inbox view.

### Pipeline

```
core/io/folder-tags.ts    noise classification + qualification. Pure. The rules.
core/io/ingest.ts         RawEntry[] → records: dedupe, tag union, status routing.
core/io/chrome-import.ts  live chrome.bookmarks tree → RawEntry[]. Roots by node id.
core/io/html-import.ts    exported .html → RawEntry[]. Roots by PERSONAL_TOOLBAR_FOLDER.
```

Parsers read a format and stop. Root detection is the only thing that legitimately differs
between them — node ids exist in the live API and not in an export. Everything downstream
is shared.

### Weaker tag sources, measured

- **URL path extraction does not generalise.** On a broad library the top domain spreads
  across hundreds of distinct path segments, most appearing once; auto-tagging by path
  manufactures roughly as many tags as it covers records.
- **Title suffixes are thin.** Many titles carry a `·`/`|`/`-` delimiter, but a large share
  of the extracted suffixes restate the domain, which is already a field.
- **Co-occurrence inference works, but only after import.** Domains with several bookmarks
  frequently have one dominant tag that predicts the rest. A good suggestion engine for
  untagged records, and it works only because the folder import supplied the labels it
  learns from.

### Personal data

A bookmark tree is personal data, and so are its folder names: employers, clients, course
codes, medical and financial interests. Exported URLs are worse — real browsing history,
and query strings holding live session identifiers.

1. **`bookmarks*.html` is gitignored.** Never commit an export. Fixtures are synthetic, in
   `scripts/fixtures/`.
2. **Rules naming personal folders live in `config/folder-rules.json`, gitignored.** Only
   generic browser containers and format patterns ship in code. No session names ship at
   all — everyone invents their own word for a tab dump. `npm run config` seeds the file
   from `config/folder-rules.example.json` so a fresh clone builds.
3. **Tests assert behaviour, not content.** Folder names in tests are abstract (`P1`,
   `SHARED`). Where a literal genuinely is the rule — date shapes, shipped container names
   — the test iterates the exported list rather than hand-picking.

---

## Portability

JSON backup and restore, two controls in a `Backup` group at the bottom of the sidebar.

**Not a view.** Nothing here is browsable, selectable or filterable, so a view would mean a
`ViewKind` member, a `<Match>`, a pane component and both the toolbar search and detail
pane gated off it, to host two buttons. The sidebar also puts them out of reach of the side
panel: replacing the whole database should not be one click away in a strip kept open while
browsing.

**Not an importer.** Every other `io/` module reads a foreign format into `RawEntry[]` and
hands it to `ingest`. `RawEntry` has no field for an id, a note, a status, an open count or
`Tag.parent`, and `ingest` hardcodes each to a default and mints a fresh id, so a backup
routed through it would return as a fresh import wearing the same URLs. Restore writes
`Bookmark` records straight through, `source` included. It also bypasses `runImport`, whose
dedupe keeps anything already in the library — under that policy a restore would write
nothing.

**Restore replaces.** `clearAll` then write. A merge cannot bring back a note you deleted or
a status you changed.

**Nothing is recomputed.** `normalizedUrl` and `domain` go back exactly as stored.
Re-deriving them would mean a change to `normalizeForDedupe`'s tracking-parameter list
silently rewrote every record it touched — gotcha #2 in a new place.

**Two clicks, the second carrying the count of what it destroys.** Choosing a different file
resets the armed state, so the button can never point at a file you have not looked at.

**A half-finished restore is survivable, so there is no rollback.** Nothing is written until
`parseBackup` accepts the file; past that point the backup is still on disk and running it
again starts by wiping. A single-transaction `replaceAll` would buy a guarantee a retry
already provides, at the cost of one unbounded transaction.

**The file excludes the `meta` store.** `searchIndex` is derived from the records and is the
largest value in the database; settings are not records.

**Validation checks identity, not every field:** a `format` marker, the schema version, and
both arrays present. The realistic mistake is picking the wrong file, and every rule beyond
that can wrongly reject someone's only copy — which is why a mangled `exportedAt` displays
as unknown rather than being fatal.

The file is pretty-printed, roughly doubling its size. The only way to check a backup is to
open it and find a record you know you saved.

---

## Design language

Both documented in `tokens.css`.

- **The domain leads the second line of each row, in monospace,** under the title. Monospace
  is the subject's vernacular: the URL bar, the terminal.
- **Amber (`--signal`) is reserved exclusively for "open in a tab right now."** It is the
  only saturated colour in the UI. Indigo handles selection and focus, red marks the two
  destructive controls, everything else is slate. Tags carry no colour.

Adding a colour means updating three places: the light block, the dark block, and the
explicit `:root[data-theme=…]` overrides.

### Layout

Sidebar full height on the left; the list **above** the detail pane, which takes a third of
the height (`2fr / 1fr`). Both scroll independently and the page itself never scrolls —
`minmax(0, …)` on each grid row is what allows that.

**Import and Backup sit at the sidebar's bottom edge.** `margin-top: auto` on the first of
the two takes the slack, so they are separated from the views by whatever the pane has
spare rather than by a chosen gap; a pane too short for that degrades to plain stacking.

In the detail pane the action leads the URL on one row — they are one statement, and
stacking them spent a row of the pane whose scarce axis is height.

The detail pane was a third column until horizontal space ran out: a 1440px window left the
list 646px and an 1100px window left it 306px, so rows had a domain, a title and chips to
fit in a pane that was never wide enough. Stacking gives the list the axis it was short of.

The detail strip is **wrapping flex, not `columns`** — a multi-column box with a constrained
height lays extra columns out sideways, past the right edge, where `overflow-y` cannot reach
them.

### Rows

**A row is two lines** (`--row-h-2`, sized close to the two lines it holds): title over
domain in the library and open-tabs lists, name over usage in the Tags list.

**Double-click activates**, on both: a bookmark opens or switches to its tab, a tab row
focuses that tab. `Enter` on the list does the same thing.

**No field is in a fixed-width column.** A single-line row needs one per field, and the
domain's was 148px × `--scale` — a third of a narrow pane — leaving titles rendering as
`U..`. No arrangement of `flex-shrink` fixes that: there is not enough width to divide. The
second line spends height instead, which a scrolling list has.

**`VirtualList` takes the row-height token per list** (`rowHeightVar`) and caches the probe
measurement per token. A single module-level number would window one list against another's
height. Gotchas #3 and #9 apply to both tokens.

**Attributes live in the detail pane, not on rows.** There is one per view — `DetailPane`,
`TabDetail`, `TagDetail` — in the same slot, so no row has to carry chips, counts or state
badges. That is also why tags are not on library rows: the detail pane lists them with a
remove button on each, and the search box already finds a record by tag name.
