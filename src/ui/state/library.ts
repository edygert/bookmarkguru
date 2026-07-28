import { createSignal, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { repository } from '~/core/db/idb-repository';
import { chromeTreeToBookmarks } from '~/core/io/chrome-import';
import { htmlToBookmarks } from '~/core/io/html-import';
import type { ImportResult } from '~/core/io/ingest';
import type { FolderRules } from '~/core/io/folder-tags';
// Bundled at build time. The file is gitignored — folder names from a real tree are
// personal data — and `npm run config` seeds it from the committed example, so a fresh
// clone still builds. See config/folder-rules.example.json.
import folderRules from '../../../config/folder-rules.json';
import { openTabUrlSet } from '~/core/tabs/match';
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
export type ViewKind = 'bookmarks' | 'tabs';

const [view, setView] = createSignal<ViewKind>('bookmarks');
const [query, setQuery] = createSignal('');
const [filters, setFilters] = createStore<Filters>({ status: ['active'] });
const [sort, setSort] = createSignal<SortSpec>({ field: 'createdAt', dir: 'desc' });
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [selectedTabId, setSelectedTabId] = createSignal<number | null>(null);

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

    const mergedTags = mergeTags(state.tags, tags);
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

async function updateBookmark(id: string, patch: Partial<Bookmark>): Promise<void> {
  const current = state.bookmarks.find((b) => b.id === id);
  if (!current) return;
  const next: Bookmark = { ...current, ...patch, updatedAt: Date.now() };
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
function mergeTags(existing: readonly Tag[], incoming: readonly Tag[]): Tag[] {
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
 * field on a record — nothing is both active and archived — and tag filters clear with
 * the switch, since they were narrowing the view you just left.
 */
function showStatus(status: BookmarkStatus): void {
  setView('bookmarks');
  setFilters({ status: [status], tags: [] });
}

function showTabs(): void {
  setView('tabs');
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
    if (message?.kind === 'bookmarks-changed') void load();
  });
}

export const library = {
  state,
  // reads
  visible, selected, statusCounts, tagCounts, tagsById, tagNames, openUrls, isOpen,
  query, filters, sort, selectedId, view, openNowCount,
  openTabs, visibleTabs, unsavedTabCount, selectedTabId,
  // writes
  setQuery, setFilters, setSort, setSelectedId,
  showStatus, showTabs, selectTab,
  load, watch, refreshOpenTabs, importFromChrome, importFromHtmlFile,
  saveTabs, saveAllOpenTabs, focusTab,
  activate, updateBookmark, removeBookmark,
};
