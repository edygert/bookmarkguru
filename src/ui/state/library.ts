import { createSignal, createMemo } from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import { repository } from '~/core/db/idb-repository';
import { chromeTreeToBookmarks } from '~/core/io/chrome-import';
import { htmlToBookmarks } from '~/core/io/html-import';
import { parseBackup, serializeBackup } from '~/core/io/json-backup';
import type { ImportResult } from '~/core/io/ingest';
import type { FolderRules } from '~/core/io/folder-tags';
// Bundled at build time. The file is gitignored — folder names from a real tree are
// personal data — and `npm run config` seeds it from the committed example, so a fresh
// clone still builds. See config/folder-rules.example.json.
import folderRules from '../../../config/folder-rules.json';
import { openTabUrlSet } from '~/core/tabs/match';
import { colorForTag, findNameConflict, retag } from '~/core/tags';
import { tagIdFromName } from '~/core/ids';
import { tabsToBookmarks, windowOrdinals, type TabGroupLike } from '~/core/io/tabs-import';
import { domainOf, isIngestable, normalizeForDedupe, normalizeForMatch } from '~/core/normalize-url';
import { runQuery } from '~/core/search/query';
import { META } from '~/core/db/schema';
import { broadcast, send } from '~/shared/messages';
import type {
  Bookmark, BookmarkStatus, Filters, ImportSummary, SortSpec, Tag,
} from '~/core/types';

/**
 * The single reactive store, shared by all three surfaces.
 *
 * This is the *only* place Solid meets the repository. `src/core/` stays framework-free
 * (enforced by scripts/guard-isolation.mjs), so everything below is a thin adapter:
 * load data in, hand plain arrays to the pure query pipeline, write changes back.
 *
 * `createStore` rather than a signal holding an array — a signal would notify every
 * consumer on any change, so editing one bookmark would re-render all 5,000 rows.
 */

interface LibraryState {
  bookmarks: Bookmark[];
  tags: Tag[];
  loading: boolean;
  error: string | null;
}

const [state, setState] = createStore<LibraryState>({
  bookmarks: [],
  tags: [],
  loading: true,
  error: null,
});

/** Normalized URLs open in a tab right now. Drives the signature "open" indicator. */
const [openUrls, setOpenUrls] = createSignal<ReadonlySet<string>>(new Set());

/** Raw tabs and groups, kept so the open-tabs view and a capture read the same data. */
const [rawTabs, setRawTabs] = createSignal<readonly chrome.tabs.Tab[]>([]);
const [rawGroups, setRawGroups] = createSignal<readonly TabGroupLike[]>([]);

// ── view state ────────────────────────────────────────────────────────────────

/**
 * Which list the middle pane is showing.
 *
 * `bookmarks` is the library under `filters`; `tabs` is what the browser has open right
 * now, most of which may not be in the library at all. They are separate views rather
 * than one more filter because the tab view lists things that are *not records* — a
 * filter cannot surface a URL the database has never seen.
 */
export type ViewKind = 'bookmarks' | 'tabs' | 'tags';

const [view, setView] = createSignal<ViewKind>('bookmarks');
const [query, setQuery] = createSignal('');
const [filters, setFilters] = createStore<Filters>({ status: ['active'] });
const [sort, setSort] = createSignal<SortSpec>({ field: 'createdAt', dir: 'desc' });
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [selectedTabId, setSelectedTabId] = createSignal<number | null>(null);
const [selectedTagId, setSelectedTagId] = createSignal<string | null>(null);

const tagNames = createMemo(() => new Map(state.tags.map((t) => [t.id, t.name])));
const tagsById = createMemo(() => new Map(state.tags.map((t) => [t.id, t])));

/**
 * The visible list. Recomputes only when something it actually reads changes —
 * no invalidation to remember, no dependency array to keep in sync.
 */
const visible = createMemo(() =>
  runQuery({
    bookmarks: state.bookmarks,
    query: query(),
    filters,
    sort: sort(),
    openUrls: openUrls(),
    tagNames: tagNames(),
  }),
);

const selected = createMemo(() => {
  const id = selectedId();
  return id ? state.bookmarks.find((b) => b.id === id) : undefined;
});

/**
 * Is this bookmark open in a tab right now?
 *
 * Must use *match* normalization, not the stored `normalizedUrl` (which is
 * dedupe-normalized and strips fragments and tracking params). Comparing against the
 * stored key would both miss most matches and, worse, disagree with what clicking
 * actually does — the badge would claim "open" while activate() opened a second tab.
 */
function isOpen(bookmark: Bookmark): boolean {
  return openUrls().has(normalizeForMatch(bookmark.url));
}

/** Counts per status, for the sidebar. Computed once rather than per nav item. */
const statusCounts = createMemo(() => {
  const counts: Record<BookmarkStatus, number> = { active: 0, inbox: 0, archived: 0 };
  for (const b of state.bookmarks) counts[b.status]++;
  return counts;
});

const tagCounts = createMemo(() => {
  const counts = new Map<string, number>();
  for (const b of state.bookmarks) {
    if (b.status !== 'active') continue;
    for (const id of b.tags) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
});

/** Records carrying a tag, split by status. See `tagUsage` for why the split matters. */
export interface TagUsage {
  active: number;
  inbox: number;
  archived: number;
  total: number;
}

const EMPTY_USAGE: TagUsage = { active: 0, inbox: 0, archived: 0, total: 0 };

/**
 * How many records each tag is on, **across every status**.
 *
 * Deliberately not `tagCounts`, which counts active records only because it sits beside a
 * sidebar control that filters the library. This one sits beside Delete, which strips the
 * tag from inbox and archived records too — so reusing the filter's count would understate
 * what deleting costs, in a browser where the inbox is exactly where untriaged captures
 * pile up. A count next to a control has to be the count that control produces.
 *
 * Seeded from `state.tags` so a tag on zero records still has an entry: those are precisely
 * the ones the sidebar hides and the tag view has to show.
 */
const tagUsage = createMemo(() => {
  const usage = new Map<string, TagUsage>();
  for (const tag of state.tags) {
    usage.set(tag.id, { active: 0, inbox: 0, archived: 0, total: 0 });
  }

  for (const b of state.bookmarks) {
    for (const id of b.tags) {
      const entry = usage.get(id);
      // A tag id with no tag record. Nothing renders it, so counting it would produce a
      // total no view can account for.
      if (!entry) continue;
      entry[b.status]++;
      entry.total++;
    }
  }
  return usage;
});

/** One row of the tag view. `parent` is resolved so the row can render `P1 · SHARED`. */
export interface TagRow {
  tag: Tag;
  parent: Tag | undefined;
  usage: TagUsage;
}

/**
 * Every tag, narrowed by the toolbar search box — the same box and the same signal the
 * bookmark and tab views use, so one search covers all three.
 *
 * Matches the qualifying parent's name as well as the tag's own, because a qualified tag
 * shows as `P1 · SHARED` and searching for what you can see should find it.
 */
const visibleTags = createMemo<TagRow[]>(() => {
  const usage = tagUsage();
  const byId = tagsById();
  const needle = query().trim().toLowerCase();

  const rows = state.tags.map((tag) => ({
    tag,
    parent: tag.parent === undefined ? undefined : byId.get(tag.parent),
    usage: usage.get(tag.id) ?? EMPTY_USAGE,
  }));

  const matched = needle
    ? rows.filter(
        (row) =>
          row.tag.name.toLowerCase().includes(needle) ||
          (row.parent?.name.toLowerCase().includes(needle) ?? false),
      )
    : rows;

  return matched.sort(
    (a, b) => b.usage.total - a.usage.total || a.tag.name.localeCompare(b.tag.name),
  );
});

const selectedTag = createMemo(() => {
  const id = selectedTagId();
  return id ? state.tags.find((t) => t.id === id) : undefined;
});

/**
 * How many rows the "open now" filter would leave — **not** how many tabs are open.
 *
 * Those are wildly different numbers (171 tabs, a handful of them bookmarked), and
 * showing the tab count next to a bookmark filter is the bug this replaces: the control
 * advertised 171 and delivered an empty list. A count beside a filter has to be the
 * count that filter produces, so this runs the real pipeline with `openNow` forced on
 * rather than counting something adjacent and hoping.
 */
const openNowCount = createMemo(() =>
  runQuery({
    bookmarks: state.bookmarks,
    query: query(),
    filters: { ...filters, openNow: true },
    sort: sort(),
    openUrls: openUrls(),
    tagNames: tagNames(),
  }).length,
);

/**
 * How many rows each domain would leave, given every other filter and the search box.
 *
 * Same rule as `openNowCount`: a number beside a control has to be the number that
 * control produces. Lifting `domains` out of the filter and bucketing what comes back
 * gets every domain's count from a *single* pipeline run — `runQuery` once per domain
 * would be O(domains × records), and there are thousands of both.
 *
 * The buckets are disjoint because a record has exactly one domain, which is what makes
 * the arithmetic honest when two domains are selected: `domains` is an OR-list, so the
 * rows really are the sum of the two counts rather than some overlapping subset.
 */
const domainCounts = createMemo(() => {
  const counts = new Map<string, number>();
  const rows = runQuery({
    bookmarks: state.bookmarks,
    query: query(),
    filters: { ...filters, domains: undefined },
    sort: sort(),
    openUrls: openUrls(),
    tagNames: tagNames(),
  });
  for (const b of rows) {
    // `domainOf` returns '' for a URL it cannot parse. That is not a domain, it has no
    // label anyone could read, and a filter on it would be indistinguishable from a
    // broken row — so it is counted nowhere and the row goes on showing '—'.
    if (!b.domain) continue;
    counts.set(b.domain, (counts.get(b.domain) ?? 0) + 1);
  }
  return counts;
});

/**
 * Whether anything is narrowing the list, which is what decides if `Clear filters` is
 * worth showing. `status` is excluded deliberately — that is the view, not a narrowing,
 * and there is no such thing as clearing it.
 */
const hasNarrowing = () =>
  (filters.tags?.length ?? 0) > 0 ||
  (filters.domains?.length ?? 0) > 0 ||
  filters.openNow === true;

// ── open tabs ─────────────────────────────────────────────────────────────────

/** One open tab, flattened for display. `saved` is resolved against the library. */
export interface OpenTab {
  id: number;
  url: string;
  title: string;
  domain: string;
  windowId: number;
  windowOrdinal: number;
  index: number;
  groupId: number;
  groupTitle: string | undefined;
  groupColor: string | undefined;
  /** The library record for this URL, when there is one. */
  bookmarkId: string | undefined;
  /**
   * Can this tab be saved at all? Browser-internal pages cannot — including this
   * extension's own, which is most of what is open while the e2e suite runs.
   *
   * Listed anyway, because the view claims to show what the browser has open and
   * quietly dropping rows would make the count disagree with the window in front of
   * you. They just carry no Save action and are left out of the capture count.
   */
  saveable: boolean;
}

/**
 * Every open tab, in the order the browser shows them: by window, then by position.
 *
 * `chrome.tabs.query({})` happens to return that order today, but nothing documents it,
 * and a wrong order here would make a 171-row list unreadable rather than obviously
 * broken. Sorting by the window's *ordinal* keeps it consistent with the tags a capture
 * writes, so "Window 3" in the sidebar is the third block of rows in the list.
 */
const openTabs = createMemo<OpenTab[]>(() => {
  const tabs = rawTabs();
  const ordinals = windowOrdinals(tabs);
  const groupById = new Map(rawGroups().map((g) => [g.id, g]));
  const byNormalizedUrl = new Map(state.bookmarks.map((b) => [b.normalizedUrl, b.id]));

  return tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
      tab.id !== undefined && !!tab.url)
    .map((tab) => {
      const group = tab.groupId >= 0 ? groupById.get(tab.groupId) : undefined;
      const title = group?.title?.trim();

      return {
        id: tab.id,
        url: tab.url,
        title: tab.title?.trim() || tab.url,
        domain: domainOf(tab.url),
        windowId: tab.windowId,
        windowOrdinal: ordinals.get(tab.windowId) ?? 0,
        index: tab.index,
        groupId: tab.groupId,
        groupTitle: title || undefined,
        groupColor: group?.color,
        bookmarkId: byNormalizedUrl.get(normalizeForDedupe(tab.url)),
        saveable: isIngestable(tab.url),
      };
    })
    .sort((a, b) => a.windowOrdinal - b.windowOrdinal || a.index - b.index);
});

/** The tab list after the search box. Same box, so one search covers both views. */
const visibleTabs = createMemo(() => {
  const needle = query().trim().toLowerCase();
  if (!needle) return openTabs();

  return openTabs().filter((tab) =>
    tab.title.toLowerCase().includes(needle) ||
    tab.url.toLowerCase().includes(needle) ||
    (tab.groupTitle?.toLowerCase().includes(needle) ?? false));
});

/**
 * How many rows the capture button would actually add.
 *
 * Excludes what `ingest` will refuse — a browser with the manager, the panel and a
 * popup open would otherwise offer to save three tabs it is about to skip, which is the
 * same "count that does not match the action" fault this whole view exists to fix.
 */
const unsavedTabCount = createMemo(() => {
  const fresh = new Set<string>();
  for (const tab of visibleTabs()) {
    // Deduped, because the same page open in two windows is one record, not two — the
    // number has to be what the capture adds, not how many rows have a Save button.
    if (tab.saveable && tab.bookmarkId === undefined) fresh.add(normalizeForDedupe(tab.url));
  }
  return fresh.size;
});

// ── actions ───────────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  try {
    const [bookmarks, tags] = await Promise.all([repository.getAll(), repository.getTags()]);
    setState({ bookmarks, tags, loading: false, error: null });
  } catch (error) {
    setState({ loading: false, error: describe(error) });
  }
}

async function refreshOpenTabs(): Promise<void> {
  // Extension pages have full access to chrome.tabs, so the open-tab set is tracked
  // here rather than in the service worker — no message round-trip, and no reliance
  // on worker state that MV3 is free to discard at any moment.
  const tabs = await chrome.tabs.query({});
  setOpenUrls(openTabUrlSet(tabs));
  setRawTabs(tabs);

  // Groups are cosmetic — they supply a tag name and a chip colour. A browser that does
  // not implement tabGroups must still get its open-tab set, so this cannot be allowed
  // to reject the whole refresh.
  try {
    setRawGroups(await chrome.tabGroups.query({}));
  } catch {
    setRawGroups([]);
  }
}

const EMPTY_SUMMARY: ImportSummary = {
  added: 0, alreadySaved: 0, skipped: 0, tagsCreated: 0, inboxed: 0,
};

/**
 * One-directional migration from Chrome's bookmark tree. Runs in the page context,
 * not the worker, so a large import cannot be killed halfway by worker termination.
 */
const rules: FolderRules = folderRules;

async function importFromChrome(): Promise<ImportSummary> {
  return runImport(async () =>
    chromeTreeToBookmarks(await chrome.bookmarks.getTree(), { rules }));
}

/**
 * Import an exported bookmarks HTML file.
 *
 * Same rules as the live path — they share `folder-tags.ts` and `ingest.ts` — but reading
 * a file lets the same input be imported repeatedly while tag rules are being tuned,
 * which a live tree that changes underneath you does not.
 */
async function importFromHtmlFile(file: File): Promise<ImportSummary> {
  return runImport(async () => htmlToBookmarks(await file.text(), { rules }));
}

/** Shared write path: dedupe against the library, chunk the writes, refresh, broadcast. */
async function runImport(produce: () => Promise<ImportResult>): Promise<ImportSummary> {
  setState('loading', true);
  try {
    const { bookmarks, tags, summary } = await produce();

    // Anything already in the library wins; the import must not clobber edits.
    const existing = new Set(state.bookmarks.map((b) => b.normalizedUrl));
    const fresh = bookmarks.filter((b) => !existing.has(b.normalizedUrl));

    const mergedTags = unionTags(state.tags, tags);
    await repository.putTags(mergedTags);

    // Chunked so one enormous transaction cannot stall the UI thread.
    for (let i = 0; i < fresh.length; i += 500) {
      await repository.putMany(fresh.slice(i, i + 500));
    }
    await repository.setMeta(META.firstRunComplete, true);

    await load();
    broadcast({ kind: 'bookmarks-changed', ids: fresh.map((b) => b.id) });

    return {
      ...summary,
      added: fresh.length,
      alreadySaved: summary.alreadySaved + (bookmarks.length - fresh.length),
      inboxed: fresh.filter((b) => b.status === 'inbox').length,
    };
  } catch (error) {
    setState({ loading: false, error: describe(error) });
    return EMPTY_SUMMARY;
  }
}

// ── backup / restore ──────────────────────────────────────────────────────────

/**
 * Serialize the whole library for download.
 *
 * Reads through the repository rather than off `state`, because the store holds only what
 * the *current surface* has loaded and a backup has to be the database. `getAll` also
 * returns plain structured-clone output, so there is no proxy to think about.
 */
async function exportBackup(): Promise<string> {
  const [bookmarks, tags] = await Promise.all([repository.getAll(), repository.getTags()]);
  return serializeBackup(bookmarks, tags);
}

/**
 * Replace the library with a backup file.
 *
 * **Deliberately not `runImport`.** That path filters incoming records against the existing
 * library on `normalizedUrl` with "anything already in the library wins", so a restore run
 * through it would write nothing at all. It also routes through `ingest`, which mints fresh
 * ids and resets notes, favourites and open counts to defaults — every field a backup exists
 * to carry. Restore writes `Bookmark` records straight through instead.
 *
 * Nothing is written until `parseBackup` has accepted the file. Past that point a failure
 * can leave the library half-written, and that is survivable rather than something to
 * engineer around: the backup file is still on disk, and running it again starts by wiping.
 * The error message says so.
 *
 * Reports through its return value rather than `state.error`, which drives the banner over
 * the list. A rejected file is a problem with the file you just picked, so it belongs beside
 * the picker; a banner in another pane makes you hunt for what you did wrong.
 */
async function restoreBackup(
  text: string,
): Promise<{ ok: boolean; restored: number; error?: string }> {
  const parsed = parseBackup(text);
  if (!parsed.ok) return { ok: false, restored: 0, error: parsed.reason };

  setState('loading', true);
  try {
    const { bookmarks, tags } = parsed.payload;

    await repository.clearAll();
    await repository.putTags(tags);
    // Chunked like the import path, so one enormous transaction cannot stall the UI thread.
    for (let i = 0; i < bookmarks.length; i += 500) {
      await repository.putMany(bookmarks.slice(i, i + 500));
    }
    // `clearAll` wipes `meta` too, so without this a restored library would come back
    // showing the first-run empty state over several thousand records.
    await repository.setMeta(META.firstRunComplete, true);

    // Every id the UI was pointing at is gone. The narrowing filters matter most: a stale
    // tag id or domain still narrows the query, so leaving either set would show an empty
    // library after a restore that worked perfectly.
    setSelectedId(null);
    setSelectedTagId(null);
    setFilters('tags', undefined);
    setFilters('domains', undefined);

    await load();
    broadcast({ kind: 'bookmarks-changed', ids: [] });
    broadcast({ kind: 'tags-changed' });
    return { ok: true, restored: bookmarks.length };
  } catch (error) {
    setState('loading', false);
    return {
      ok: false,
      restored: 0,
      error: `${describe(error)} The library may be incomplete — restore the same file again.`,
    };
  }
}

/**
 * Capture open tabs into the inbox.
 *
 * Runs in the page context like every other import, for the same reason: MV3 will
 * terminate an idle worker after ~30s, and a browser with a few hundred tabs is exactly
 * the case where a bulk write would be killed halfway.
 *
 * Ordinals are computed over **every** open window, not over `tabs`. Saving a filtered
 * subset must keep the numbering the user was looking at — otherwise capturing one
 * window's worth of rows labels them `Window 1` whichever window they came from.
 */
async function saveTabs(tabs: readonly OpenTab[]): Promise<ImportSummary> {
  const ordinals = windowOrdinals(rawTabs());

  return runImport(async () =>
    tabsToBookmarks(tabs, {
      groups: rawGroups(),
      windowOrdinals: ordinals,
      status: 'inbox',
    }));
}

/** Capture everything open, ignoring whatever the search box is narrowing to. */
async function saveAllOpenTabs(): Promise<ImportSummary> {
  return saveTabs(openTabs());
}

/** Focus a tab that is already open. Not open-or-switch: we know exactly which one. */
async function focusTab(tab: OpenTab): Promise<void> {
  await chrome.tabs.update(tab.id, { active: true });
  // The match is frequently in another window, which must come forward too.
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Open the bookmark, reusing an existing tab when one already shows it. */
async function activate(bookmark: Bookmark): Promise<void> {
  await send({ kind: 'open-or-switch', url: bookmark.url, bookmarkId: bookmark.id });
  // The worker owns the openCount write; mirror it locally so the UI updates now
  // rather than waiting for a reload.
  patchLocal(bookmark.id, { lastOpenedAt: Date.now(), openCount: bookmark.openCount + 1 });
  void refreshOpenTabs();
}

/**
 * ⚠️ `unwrap`, not a spread. This is the same trap as `mergeTags` below, one level down.
 *
 * `{ ...current }` produces a plain object whose **nested** values are still store
 * proxies — `tags` is a proxied array and `source` a proxied object — and structured
 * clone cannot clone either, so `put` throws
 * `"[object Array] could not be cloned"`. The failure is near-invisible: `patchLocal`
 * has already run, so the list, the cursor and the detail pane all show the new value
 * while nothing reaches IndexedDB, and the record reverts on the next reload.
 *
 * `unwrap` returns the underlying record, whose nested values are the raw ones. A
 * hand-written list of nested spreads would work too and would silently rot the first
 * time someone adds a nested field.
 */
async function updateBookmark(id: string, patch: Partial<Bookmark>): Promise<void> {
  const current = state.bookmarks.find((b) => b.id === id);
  if (!current) return;
  const next: Bookmark = { ...unwrap(current), ...patch, updatedAt: Date.now() };
  patchLocal(id, { ...patch, updatedAt: next.updatedAt });
  await repository.put(next);
  broadcast({ kind: 'bookmarks-changed', ids: [id] });
}

async function removeBookmark(id: string): Promise<void> {
  setState('bookmarks', (list) => list.filter((b) => b.id !== id));
  if (selectedId() === id) setSelectedId(null);
  await repository.remove(id);
  broadcast({ kind: 'bookmarks-changed', ids: [id] });
}

function patchLocal(id: string, patch: Partial<Bookmark>): void {
  setState(
    'bookmarks',
    (b) => b.id === id,
    produce((b: Bookmark) => Object.assign(b, patch)),
  );
}

// ── tags ──────────────────────────────────────────────────────────────────────

/**
 * Rename a tag. **No bookmark record is written** — records hold tag ids, which is the
 * entire reason they hold ids rather than names.
 *
 * The id keeps whatever text it was derived from (`tag:tools` can end up displaying
 * "Rust"). That is invisible — ids are never shown — and it is what makes a later
 * re-import of the folder `Tools` feed this renamed tag instead of resurrecting a
 * duplicate beside it, since import joins on id.
 *
 * Returns the tag it would have become indistinguishable from, when there is one. Merging
 * is out of scope, so the rename is refused rather than silently creating two identical
 * rows the user cannot tell apart afterwards.
 */
async function renameTag(id: string, name: string): Promise<{ ok: boolean; conflict?: string }> {
  const current = state.tags.find((t) => t.id === id);
  const clean = name.trim();
  if (!current || !clean || clean === current.name) return { ok: true };

  const conflict = findNameConflict(state.tags, id, clean);
  if (conflict) return { ok: false, conflict: conflict.name };

  setState('tags', (t) => t.id === id, 'name', clean);
  await repository.putTag({ ...unwrap(current), name: clean });
  broadcast({ kind: 'tags-changed' });
  return { ok: true };
}

async function setTagColor(id: string, color: string): Promise<void> {
  const current = state.tags.find((t) => t.id === id);
  if (!current || current.color === color) return;

  setState('tags', (t) => t.id === id, 'color', color);
  await repository.putTag({ ...unwrap(current), color });
  broadcast({ kind: 'tags-changed' });
}

/**
 * Create a tag, or hand back the existing one that name already resolves to.
 *
 * Ids derive from the name, so "Rust" typed by hand and a folder named `Rust` are one tag
 * by construction. Returning the existing record rather than writing over it keeps a
 * rename intact: typing the *old* name attaches the tag you renamed, it does not reset it.
 */
async function createTag(name: string, color?: string): Promise<Tag | undefined> {
  const clean = name.trim();
  if (!clean) return undefined;

  const id = tagIdFromName(clean);
  const existing = state.tags.find((t) => t.id === id);
  if (existing) return unwrap(existing);

  const tag: Tag = { id, name: clean, color: color ?? colorForTag(clean) };
  setState('tags', (list) => [...list, tag]);
  await repository.putTag(tag);
  broadcast({ kind: 'tags-changed' });
  return tag;
}

/**
 * Delete a tag and strip it from every record that carries it. **No bookmark is deleted.**
 *
 * Two things are load-bearing here:
 *
 * - **`unwrap` before `retag`.** These records come out of the Solid store, so they are
 *   proxies, and `retag` spreads one level — nested `tags` and `source` would stay
 *   proxied and IndexedDB would throw `"[object Array] could not be cloned"` on the write.
 *   That failure is near-silent: the UI has already repainted. This is the third time this
 *   boundary has bitten; see the gotchas in PROGRESS.md.
 * - **Records first, tag record last.** A failure between the two leaves records carrying
 *   a tag that still exists, which is merely untidy. The reverse leaves ids pointing at a
 *   deleted tag: no chip renders them and no filter matches them, so the tag is gone from
 *   view while still costing every record a slot.
 */
async function deleteTag(id: string): Promise<number> {
  const tag = state.tags.find((t) => t.id === id);
  if (!tag) return 0;

  const changed = retag(unwrap(state.bookmarks), id, null);

  // Chunked for the same reason an import is: one transaction over a few thousand
  // records stalls the UI thread.
  for (let i = 0; i < changed.length; i += 500) {
    await repository.putMany(changed.slice(i, i + 500));
  }
  await repository.removeTag(id);

  setState('tags', (list) => list.filter((t) => t.id !== id));
  for (const record of changed) patchLocal(record.id, { tags: record.tags, updatedAt: record.updatedAt });

  // A filter pointing at a tag that no longer exists shows an empty list under a sidebar
  // row that is also gone — nothing on screen would explain where the records went.
  const active = filters.tags ?? [];
  if (active.includes(id)) setFilters('tags', active.filter((t) => t !== id));
  if (selectedTagId() === id) setSelectedTagId(null);

  broadcast({ kind: 'tags-changed' });
  if (changed.length > 0) broadcast({ kind: 'bookmarks-changed', ids: changed.map((b) => b.id) });
  return changed.length;
}

async function addTagToBookmark(bookmarkId: string, tagId: string): Promise<void> {
  const current = state.bookmarks.find((b) => b.id === bookmarkId);
  if (!current || current.tags.includes(tagId)) return;
  // Spreading a proxied array of *strings* is safe — the elements are primitives.
  await updateBookmark(bookmarkId, { tags: [...current.tags, tagId] });
}

async function removeTagFromBookmark(bookmarkId: string, tagId: string): Promise<void> {
  const current = state.bookmarks.find((b) => b.id === bookmarkId);
  if (!current || !current.tags.includes(tagId)) return;
  await updateBookmark(bookmarkId, { tags: current.tags.filter((id) => id !== tagId) });
}

/**
 * ⚠️ `existing` comes out of the Solid store, so every element is a **proxy**.
 *
 * IndexedDB structured-clones whatever it stores and cannot clone a proxy: `put` throws
 * `"#<Object> could not be cloned"`, which surfaces as a failed import with a message
 * that points nowhere near this function. Spreading gives plain objects.
 *
 * This stayed hidden for a while because it only bites on the *second* write. The first
 * import runs against an empty store, so `existing` is `[]` and nothing proxied is ever
 * handed to IndexedDB.
 */
function unionTags(existing: readonly Tag[], incoming: readonly Tag[]): Tag[] {
  const byId = new Map(existing.map((t) => [t.id, { ...t }]));
  for (const tag of incoming) if (!byId.has(tag.id)) byId.set(tag.id, tag);
  return [...byId.values()];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── view actions ──────────────────────────────────────────────────────────────

/**
 * Show one status view. The three are mutually exclusive because `status` is a single
 * field on a record — nothing is both active and archived — and the sidebar's list
 * selections clear with the switch, since they were narrowing the view you just left.
 *
 * `tags` and `domains` are named explicitly: this is the object form of a store setter,
 * which *merges*, so a key left out survives. `openNow` and `tagMode` are left out on
 * purpose — the first is a toolbar toggle you can see the state of, and the second is a
 * preference about how tags combine rather than a selection of anything.
 */
function showStatus(status: BookmarkStatus): void {
  setView('bookmarks');
  setFilters({ status: [status], tags: [], domains: [] });
}

function showTabs(): void {
  setView('tabs');
}

function showTags(): void {
  setView('tags');
}

/**
 * Jump from a tag to the records that carry it.
 *
 * The bridge between managing tags and using them: before removing a tag you want to see
 * what is on it, and the Library is where that lives. Statuses are widened to all three
 * because the tag view counts all three — landing on a filter that hides two thirds of the
 * records you were just shown a count for is the same class of fault as counting the wrong
 * thing in the first place.
 */
function showRecordsForTag(id: string): void {
  setView('bookmarks');
  setQuery('');
  setFilters({ status: ['active', 'inbox', 'archived'], tags: [id], domains: [] });
}

/**
 * Narrow to one domain, from a row rather than from the sidebar list.
 *
 * Replaces the domain filter instead of adding to it: clicking the domain on a row means
 * "show me this one", where clicking a sidebar row means "add this to what I am already
 * looking at". Same field, two different intents, and guessing wrong is a filter you did
 * not ask for.
 */
function filterToDomain(domain: string): void {
  if (!domain) return;
  setView('bookmarks');
  setFilters('domains', [domain]);
}

/**
 * Clear what narrows the list, leaving the view alone.
 *
 * `status` stays because it *is* the view — the sidebar would have nothing selected. So
 * does `tagMode`, which says how tags combine rather than selecting any.
 */
function clearFilters(): void {
  setFilters({ tags: [], domains: [], openNow: undefined });
}

/** Selecting a tab shows its record in the detail pane, when it has one. */
function selectTab(tab: OpenTab): void {
  setSelectedTabId(tab.id);
  setSelectedId(tab.bookmarkId ?? null);
}

/** Live-update the open-tab set and stay in sync with writes from other surfaces. */
function watch(): void {
  void refreshOpenTabs();
  const refresh = () => void refreshOpenTabs();

  chrome.tabs.onUpdated.addListener(refresh);
  chrome.tabs.onRemoved.addListener(refresh);
  chrome.tabs.onCreated.addListener(refresh);
  // Reordering and moving between windows changes the list order, which the tab view
  // shows directly; neither fires onUpdated.
  chrome.tabs.onMoved.addListener(refresh);
  chrome.tabs.onAttached.addListener(refresh);

  // Renaming or recolouring a group changes chips and tag names but touches no tab.
  try {
    chrome.tabGroups.onUpdated.addListener(refresh);
    chrome.tabGroups.onRemoved.addListener(refresh);
  } catch {
    // No tabGroups support. The tab list still works, just without group chips.
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === 'bookmarks-changed' || message?.kind === 'tags-changed') void load();
  });
}

export const library = {
  state,
  // reads
  visible, selected, statusCounts, tagCounts, tagsById, tagNames, openUrls, isOpen,
  query, filters, sort, selectedId, view, openNowCount, domainCounts, hasNarrowing,
  openTabs, visibleTabs, unsavedTabCount, selectedTabId,
  tagUsage, visibleTags, selectedTag, selectedTagId,
  // writes
  setQuery, setFilters, setSort, setSelectedId, setSelectedTagId,
  showStatus, showTabs, showTags, showRecordsForTag, selectTab,
  filterToDomain, clearFilters,
  load, watch, refreshOpenTabs, importFromChrome, importFromHtmlFile,
  exportBackup, restoreBackup,
  saveTabs, saveAllOpenTabs, focusTab,
  activate, updateBookmark, removeBookmark,
  renameTag, setTagColor, createTag, deleteTag,
  addTagToBookmark, removeTagFromBookmark,
};
