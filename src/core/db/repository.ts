import type { Bookmark, Collection, SavedSearch, Tag } from '../types';

/**
 * The storage seam.
 *
 * The only implementation today is IndexedDB (`IdbRepository`). This interface exists
 * so the UI and services depend on a contract rather than on IndexedDB directly —
 * storage can move later without touching anything above it.
 *
 * Every method is async even where a given backend could answer synchronously, so
 * that swapping the backend never changes a call site.
 */
export interface BookmarkRepository {
  // ── bookmarks ────────────────────────────────────────────────────────────────
  get(id: string): Promise<Bookmark | undefined>;
  getMany(ids: string[]): Promise<Bookmark[]>;
  getAll(): Promise<Bookmark[]>;
  /** Returns every match — duplicates are expected and reviewed, not prevented. */
  findByNormalizedUrl(normalizedUrl: string): Promise<Bookmark[]>;
  put(bookmark: Bookmark): Promise<void>;
  /** Single transaction. Callers chunk large imports; see io/ingest. */
  putMany(bookmarks: Bookmark[]): Promise<void>;
  remove(id: string): Promise<void>;
  removeMany(ids: string[]): Promise<void>;
  count(): Promise<number>;

  // ── tags ─────────────────────────────────────────────────────────────────────
  getTags(): Promise<Tag[]>;
  putTag(tag: Tag): Promise<void>;
  putTags(tags: Tag[]): Promise<void>;
  removeTag(id: string): Promise<void>;

  // ── collections ──────────────────────────────────────────────────────────────
  getCollections(): Promise<Collection[]>;
  putCollection(collection: Collection): Promise<void>;
  removeCollection(id: string): Promise<void>;

  // ── saved searches ───────────────────────────────────────────────────────────
  getSavedSearches(): Promise<SavedSearch[]>;
  putSavedSearch(savedSearch: SavedSearch): Promise<void>;
  removeSavedSearch(id: string): Promise<void>;

  // ── meta ─────────────────────────────────────────────────────────────────────
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;

  /** Drop every record. Used by restore-from-backup and by tests. */
  clearAll(): Promise<void>;
}
