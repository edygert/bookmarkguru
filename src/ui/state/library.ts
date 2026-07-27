import { createSignal, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { repository } from '~/core/db/idb-repository';
import { chromeTreeToBookmarks } from '~/core/io/chrome-import';
import { openTabUrlSet } from '~/core/tabs/match';
import { normalizeForMatch } from '~/core/normalize-url';
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

// ── view state ────────────────────────────────────────────────────────────────

const [query, setQuery] = createSignal('');
const [filters, setFilters] = createStore<Filters>({ status: ['active'] });
const [sort, setSort] = createSignal<SortSpec>({ field: 'createdAt', dir: 'desc' });
const [selectedId, setSelectedId] = createSignal<string | null>(null);

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
  setOpenUrls(openTabUrlSet(await chrome.tabs.query({})));
}

/**
 * One-directional migration from Chrome's bookmark tree. Runs in the page context,
 * not the worker, so a large import cannot be killed halfway by worker termination.
 */
async function importFromChrome(): Promise<ImportSummary> {
  setState('loading', true);
  try {
    const tree = await chrome.bookmarks.getTree();
    const { bookmarks, tags, summary } = chromeTreeToBookmarks(tree);

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
    };
  } catch (error) {
    setState({ loading: false, error: describe(error) });
    return { added: 0, alreadySaved: 0, skipped: 0, tagsCreated: 0 };
  }
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

function mergeTags(existing: readonly Tag[], incoming: readonly Tag[]): Tag[] {
  const byId = new Map(existing.map((t) => [t.id, t]));
  for (const tag of incoming) if (!byId.has(tag.id)) byId.set(tag.id, tag);
  return [...byId.values()];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Live-update the open-tab set and stay in sync with writes from other surfaces. */
function watch(): void {
  void refreshOpenTabs();
  chrome.tabs.onUpdated.addListener(() => void refreshOpenTabs());
  chrome.tabs.onRemoved.addListener(() => void refreshOpenTabs());
  chrome.tabs.onCreated.addListener(() => void refreshOpenTabs());
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === 'bookmarks-changed') void load();
  });
}

export const library = {
  state,
  // reads
  visible, selected, statusCounts, tagCounts, tagsById, tagNames, openUrls, isOpen,
  query, filters, sort, selectedId,
  // writes
  setQuery, setFilters, setSort, setSelectedId,
  load, watch, refreshOpenTabs, importFromChrome, activate, updateBookmark, removeBookmark,
};
