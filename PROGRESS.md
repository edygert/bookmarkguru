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

11. **Never hand a Solid store value to IndexedDB.** `createStore` returns proxies, and
   structured clone cannot clone one — `put` throws `"#<Object> could not be cloned"`,
   which `runImport` catches and shows as a generic failure banner with every count
   reading zero. Nothing points at the real line. `mergeTags` read `state.tags` directly
   and so only failed on the *second* write: the first import runs against an empty store,
   where `existing` is `[]` and no proxy is ever passed along. Found by `tabs-test.mjs`,
   which now asserts a write into a non-empty store succeeds.

   ⚠️ **This has now bitten twice, and a one-level spread is not the fix.**
   `updateBookmark` did `{ ...current, ...patch }`, which yields a plain object whose
   *nested* values — `tags`, `source` — are still proxies, so `put` threw
   `"[object Array] could not be cloned"`. The second failure was quieter than the first:
   `patchLocal` had already run, so the list, the cursor and the detail pane all showed
   the new value while nothing reached IndexedDB, and the record reverted on reload.
   Use `unwrap(current)` at the store→repository boundary. A hand-written list of nested
   spreads works too and silently rots the first time someone adds a nested field. Found
   by `triage-test.mjs`, which reads status back out of IndexedDB rather than trusting
   the DOM — every DOM assertion around it passed.

   The import-time union that first hit this is now called `unionTags`, renamed away from
   `mergeTags` when tag editing landed beside it — it unions ids on import and has nothing
   to do with merging two tags together.

12. **A count next to a control must be the count that control produces.** The sidebar
   used to show `openUrls().size` — the number of open browser *tabs* — beside a control
   that filtered *bookmarks*, so it read "171" and delivered an empty list. Both are
   plausible integers and neither `tsc` nor a unit test can tell them apart, which is why
   `openNowCount` runs the real query pipeline with `openNow` forced on rather than
   counting something adjacent. The same rule is why the capture button's count excludes
   browser-internal tabs and dedupes by normalized URL: it promises records added.

   The tag view is the second instance: it needed `tagUsage`, an **all-status** count,
   because it sits beside a Delete that strips the tag from inbox and archived records
   too. Reusing the sidebar's `tagCounts` would have understated what deleting costs.

13. **Anything derived from a tag's *name* breaks the moment renaming ships.** The sidebar
   found a qualified tag's general form with `tagIdFromName(tag.name)`, which held only
   because import generates both names from the same folder. Rename one and the row does
   not move — it **vanishes**: the tag still has a `parent`, so it is excluded from the
   roots, and no root's id matches its new name any more. Ids never change, so
   `generalTagId()` derives it from the id instead. The same rule is why a tag's id keeps
   its original text (`tag:tools` can display "Rust") — ids are identity, names are
   display, and the moment those two are conflated a rename starts rewriting records.

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
manifest.config.ts          CRXJS manifest (permissions and icons live here)
public/icons/               generated PNGs; Vite copies public/ to the bundle root
scripts/make-icons.py       the editable icon source — edit this, not the PNGs
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
    tags.ts                 TagCollector, colour mapping, generalTagId, retag
    db/                     schema.ts · repository.ts (interface) · idb-repository.ts
    search/query.ts         text → filter → sort pipeline (substring today)
    tabs/match.ts           extensible matching strategy list
    io/folder-tags.ts       shared noise filters + tag qualification — the rules
    io/ingest.ts            RawEntry[] → records: dedupe, tag union, status routing
    io/chrome-import.ts     live bookmark tree → RawEntry[]
    io/html-import.ts       exported .html → RawEntry[] (regex, never DOMParser)
    io/tabs-import.ts       open tabs → RawEntry[] (no folder path; sourceTags instead)
  shared/messages.ts        typed message contracts
  background/service-worker.ts
  ui/
    App.tsx                 shared shell; `compact` collapses to one column
    state/library.ts        the ONLY place Solid meets the repository
    components/             Sidebar · VirtualList · BookmarkList · TabList · TagList ·
                            DetailPane · TagDetail · …
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
npm run check          # isolation → permissions → tsc → 144 tests → build → CSP
npm run e2e            # build, launch headless browser, run 84 browser assertions
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

## Views, and the difference between a view and a filter

The sidebar holds **views**, one active at a time. A filter that *composes* with the
active view does not belong there, and putting one there was a real bug worth recording.

| | | |
|---|---|---|
| Library · Inbox · Archive | view | `status` is one field per record, so these partition the library |
| Open tabs | view | lists **tabs**, including ones that are not records at all |
| Tags | view | lists **tags**, including ones on no records at all |
| Open now | filter, in the toolbar | narrows whichever view is active |

**Why `Open now` moved.** It sat among the three status views, styled identically, while
behaving as a toggle that layered on top of them — so nothing distinguished "replaces the
list" from "narrows the list", and both could read as selected at once. Worse, its count
was `openUrls().size`: the number of open browser tabs, next to a control that filters
bookmarks. With 171 tabs and a mostly-unbookmarked browser it advertised 171 and produced
an empty list. See gotcha #12.

**Why `Open tabs` is a view and not a filter.** No filter over the library can show a URL
the database has never seen, and the interesting tabs are exactly the unsaved ones. The
view lists every open tab across every window, marks the ones already in the library, and
offers to capture the rest.

**Why `Tags` is a view and not a filter.** Same reason, one level up. The sidebar's tag
list shows only tags with at least one active record, because it exists to *pick a
filter* — and no filter over the library can reach a tag on zero records. Take the last
record off a tag and it would exist in IndexedDB with no surface able to rename or delete
it. The view lists every tag, marks the unused ones, and is where they get cleaned up.

### Capturing tabs

`Save N tabs` captures what the list is currently showing, search filter included; the
`save-open-tabs` command and the action's context menu capture everything. All of it
lands as `status: 'inbox'` — a window full of tabs is a triage queue, the same reasoning
that routes imported saved-tab-sets there.

Three things are deliberate:

- **Tab groups and window numbers become tags, via `sourceTags`, not via `folderPath`.**
  Routing them through the folder machinery would run them past rules built for a filing
  tree: a group named `Feb03` would be dropped as a date, and a group appearing in two
  windows would be judged ambiguous and split into `Window 3 · Research` and
  `Window 5 · Research` — the exact opposite of what qualification is for. `SourceTag`
  exists to say "a person typed this on purpose; leave it alone".
- **Window ordinals are computed over every open window**, then passed in. Left to
  default, capturing a filtered subset renumbers it, so one window's tabs come back
  labelled `Window 1` whichever window they came from.
- **The bulk write runs in the manager page, never the worker.** MV3 terminates an idle
  worker after ~30s and a few hundred tabs is precisely the write that gets killed
  halfway. The worker's whole job is to make sure a manager exists to hear the request —
  by message if one is open, by URL hash if one must be created.

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
2. ~~**Tag CRUD.**~~ **Done, without merge.** See "Tag editing" below.
3. **Filter sidebar** — domain filter, favourites, multi-tag any/all. `Filters` already
   supports all of it; the UI does not expose it yet.
4. **Favicons** — `Favicon.tsx` exists and works; wire it into more surfaces.
5. ~~**Triage mode.**~~ **Done.** See "Triage" below. Shipped as three keys on the
   existing list — `a` archive, `r` restore, `Delete` — with no mode, no undo stack and
   no new view. Supersedes the planned `InboxTriage.tsx`.
6. ~~**Open-tab import → inbox.**~~ **Done.** See "Views" above. Shipped as a sidebar
   view over the live tabs, a per-row Save, a capture button, an unbound `save-open-tabs`
   command and an action context-menu entry.

Phases 3–4 (collections, saved searches, dedupe review, HTML/JSON export) are in
`~/.claude/plans/create-a-plan-for-compressed-beaver.md`.

---

## Tag editing

**Shipped.** Rename, recolour, delete, and per-record add/remove. The `Tags` view holds
the list; the pane the bookmark detail normally occupies holds the editor.

### There is deliberately no merge

The roadmap promised one. It is not needed, and the reason is a property of how import
works: **a qualified tag is always emitted alongside its general form**, so a record
tagged `P1 · SHARED` already carries `SHARED` too. Deleting the redundant qualified tag
therefore loses nothing — the broad grouping survives, because it was never routed through
the qualified tag in the first place.

That covers the case import over-produces, which is the case the merge UI existed for.
What merge would still buy is folding together two tags that were created independently
and happen to mean the same thing — and import cannot generate that pair, since ids derive
from names. It is a one-way door with no undo behind it, so it stays unbuilt until
something actually needs it.

### Renaming writes no bookmark record

`Bookmark.tags` holds ids; a rename touches one field on one tag record. Two consequences:

- **A tag's id keeps its original text.** `tag:tools` can display "Rust". That is invisible
  — ids are never shown — and it is what makes a later re-import of the folder `Tools` feed
  the renamed tag rather than resurrecting a duplicate beside it, since import joins on id.
- **A rename onto a name already in use is refused, not merged.** The check is scoped to
  tags with the same `parent`: qualified variants deliberately share a name with their
  general form and with each other (gotcha #7), and they are still told apart on screen,
  because a qualified tag renders behind its parent's name. What is genuinely unusable is
  two tags that render identically, and with no merge there is nothing to offer instead.

### Deleting is guarded by its own count, not by a dialog

Delete strips the tag from every record and removes the tag. **No bookmark is deleted.**
It takes two clicks, and the second one's label carries the number of links it will touch —
there is no undo anywhere in this app, and that number is the whole decision. Consistent
with triage's stance that a well-placed control needs no modal, and with its reason for
gating `Delete` at all: archiving is reversible, this is not.

Order matters: **records first, tag record last.** A failure between the two leaves records
carrying a tag that still exists, which is untidy. The reverse leaves ids pointing at a
deleted tag — no chip renders them and no filter matches them, so the tag is invisible
while still occupying a slot on every record.

Deleting a general tag does **not** cascade to its qualified children. They are promoted to
roots in the sidebar and labelled with their qualifying folder, so an orphan is visible and
fixable rather than silently unrenderable.

### Adding a tag by hand cannot mint a duplicate

The detail pane's add-tag box offers existing tags with their record counts — so you attach
the one already in use rather than a near-duplicate — and a `Create` option only when the
typed name resolves to no existing id. Since ids derive from names, "Rust" typed by hand
and a folder named `Rust` are the same tag by construction.

---

## Triage

**Shipped.** Replaces `InboxTriage.tsx`, which was scoped to the inbox for no good reason,
and the keep/discard/skip design that preceded it.

Three keys, live on the list alongside `j`/`k`/`Enter`:

| Key | Effect | No-op when |
|---|---|---|
| `a` | `status → 'archived'` | already `archived` |
| `r` | `status → 'active'` | already `active` |
| `Delete` / `Backspace` | permanent delete | status is not `archived` |

### It is not a mode

There is no `triageMode` signal, no enter or exit, no toggle. Every bookmark view runs the
same three transitions; what differs between views is only which keys turn out to be
no-ops, and that is a consequence of what is in the list rather than of per-view branching.
The Library does not *disable* `r` — it holds no archived record for `r` to act on.

Per view that reads as: Library — `a` archives. Inbox — `a` archives, `r` keeps. Archive —
`r` restores, `Delete` destroys.

A mode would have needed a way in, a way out, an indicator that you are in it, and a
decision about what every other key does while you are. All of that to gate three
keystrokes that are already unambiguous.

**It operates on `library.visible()` — the current query result — not on a status.** The
inbox is only a filter (`status: ['inbox']`), so acting on the result set makes the same
keys handle the inbox, everything on a dead domain, everything tagged for a finished
course, or any search.

**No multi-select is involved.** `selectedId` is a single signal and a keep/discard pass is
inherently single-record stepping. The record leaving the list is not coded anywhere: the
sidebar's views are status filters, so a status change drops the record out of `visible()`
on its own and the next row inherits the cursor's index. `landOn()` in `BookmarkList.tsx`
exists only to bring the *selection* along, which is what makes the detail pane show the
record that took the place rather than the one just acted on.

### Why this needs no undo

The earlier design bound archive and delete to **one** key whose meaning depended on the
record's current status, which made the Archive view a surface where a held-down key
destroyed records permanently. That is what made undo a prerequisite. Separating the two
acts removes the need entirely:

- Archiving is the fast repeatable act, and it is reversible by pressing `r`.
- Deleting is a different key, on a different screen, over records you had to archive
  first — and it is guarded on the **record's** status, not on which view is showing.
  Those are equivalent today (`filters.status` always holds exactly one value), but the
  planned domain and favourite filters can produce a mixed result set, and the per-record
  guard is the one that stays correct there.

So there is no undo stack, no tombstone status, and no confirmation dialog. Deletion is
still unrecoverable — `removeBookmark` writes straight through to IndexedDB — it is just
no longer reachable by the key you are leaning on.

### Hints are per-view for the same reason counts are

The status bar advertises `a archive` in the Library, `a archive · r keep` in the Inbox,
and `r restore · ⌫ delete` in the Archive. A fixed hint line would promise `⌫ delete`
where it does nothing, which is gotcha #12 in another costume: a control's label has to
describe what that control does *here*.

---

## Known gaps

- Search is substring-only until MiniSearch is wired.
- **No undo, anywhere.** `removeBookmark` writes straight through to IndexedDB. This is
  survivable because deleting is reachable only from the Archive, by a key that does
  nothing anywhere else, over records that had to be archived first — see "Triage" above.
  Archiving, the act you actually repeat, is reversible with `r`.
- **No tag merge**, deliberately — see "Tag editing". A qualified tag that turns out to be
  redundant is *deleted*, which is safe because import emits its general form alongside it.
  Two independently-created tags meaning the same thing cannot be folded together.
- Sidebar shows status views, the open-tabs view, the tags view and tags; domain/favourite
  filters are not exposed.
- The open-tabs and tags views are manager-only. The side panel has no sidebar, so it
  cannot reach either — the panel keeps the `Open now` toggle but not the lists.
- Tag editing has no bulk actions and no undo. Deleting a tag off several hundred records
  is one click away from irreversible; the count on the button is the only guard.
- Triage has no bulk actions: it is one record per keystroke by design. Emptying a
  thousand-record inbox is a thousand keystrokes.
- No collections, saved searches, bulk actions, or dedupe review UI yet.
- No HTML or JSON import/export yet — **JSON backup is the only safe way to preserve
  notes and tags, so build it before relying on the library.**
- Favicon coverage is partial by design: only URLs Chrome has already cached.
- `eslint-plugin-solid` is not set up; gotcha #5 is enforced by discipline for now.
