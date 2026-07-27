/**
 * The data model for the link database.
 *
 * This is deliberately NOT Chrome's bookmark tree. Organisation is many-to-many via
 * tags and collections; the folder tree only ever appears as an import artifact that
 * has already been converted into tags.
 */

/**
 * Replaces a standalone `archived: boolean`. The three states are mutually exclusive,
 * and an enum makes the contradictory combination unrepresentable — two booleans
 * (`archived` + `inbox`) could both be true, and nothing would stop them.
 *
 * - `active`   — in the library proper
 * - `inbox`    — captured from open tabs, awaiting triage; hidden from default views
 * - `archived` — kept, but out of the way
 */
export type BookmarkStatus = 'active' | 'inbox' | 'archived';

export type SourceKind =
  | 'manual'
  | 'chrome-import'
  | 'html-import'
  | 'json-restore'
  | 'tab-import';

export interface SourceMeta {
  kind: SourceKind;
  importedAt?: number;
  /** Folder path preserved verbatim from an import; also converted into tags. */
  originalFolderPath?: string;
  /** Chrome's own bookmark node id, for migration traceability only. */
  chromeId?: string;
  /** tab-import: which window the tab was in. */
  windowId?: number;
  /** tab-import: chrome.tabGroups title, when the tab belonged to a group. */
  tabGroup?: string;
}

export interface Bookmark {
  id: string;
  /** Canonical URL exactly as saved — this is what we open. */
  url: string;
  /** Derived key used for matching and dedupe. Never displayed. */
  normalizedUrl: string;
  /** Derived, indexed, used for domain filtering and grouping. */
  domain: string;
  title: string;
  description: string;
  notes: string;
  /** Tag ids, not names — renaming a tag must not rewrite every bookmark. */
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  openCount: number;
  favorite: boolean;
  pinned: boolean;
  status: BookmarkStatus;
  source: SourceMeta;
}

export interface Tag {
  id: string;
  name: string;
  /** CSS colour token or hex. Carried over from Chrome tab-group colours on import. */
  color: string;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  /** Explicit membership and explicit order — this is a hand-curated list. */
  bookmarkIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** A smart collection: stored rules, evaluated on read. */
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: Filters;
  sort: SortSpec;
  createdAt: number;
  updatedAt: number;
}

export interface Filters {
  tags?: string[];
  /** `all` = must have every listed tag; `any` = at least one. Defaults to `all`. */
  tagMode?: 'all' | 'any';
  domains?: string[];
  /** Defaults to `['active']` so inbox and archived stay out of the way. */
  status?: BookmarkStatus[];
  favorite?: boolean;
  /** Restrict to bookmarks whose URL is open in some tab right now. */
  openNow?: boolean;
}

export type SortField =
  | 'title'
  | 'domain'
  | 'createdAt'
  | 'lastOpenedAt'
  | 'openCount'
  | 'relevance';

export interface SortSpec {
  field: SortField;
  dir: 'asc' | 'desc';
}

/** Everything a full-fidelity JSON backup carries. */
export interface BackupPayload {
  schemaVersion: number;
  exportedAt: number;
  bookmarks: Bookmark[];
  tags: Tag[];
  collections: Collection[];
  savedSearches: SavedSearch[];
}

/** Result of any ingest path, shown in the import summary. */
export interface ImportSummary {
  added: number;
  /** Matched an existing record, so deliberately not re-added. */
  alreadySaved: number;
  /** Rejected as unusable (chrome:// URLs, malformed, empty). */
  skipped: number;
  tagsCreated: number;
}
