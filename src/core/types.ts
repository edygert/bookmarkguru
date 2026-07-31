/**
 * The data model for the link database.
 *
 * This is deliberately NOT Chrome's bookmark tree. Organisation is many-to-many via
 * tags; the folder tree only ever appears as an import artifact that has already been
 * converted into tags.
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

/**
 * How a record entered the library.
 *
 * Deliberately has no `json-restore` member. A restore writes records back exactly as
 * they were exported, `source` included, so it is not a source in its own right — a
 * record restored from a backup is still the chrome-import it always was. A member here
 * would invite overwriting that on the way in, which is the one thing a restore must not
 * do.
 */
export type SourceKind = 'manual' | 'chrome-import' | 'html-import' | 'tab-import';

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
  /**
   * When a *saved tab set* was captured, parsed from its enclosing date-named folder
   * (`Snapshots/1999-01-15`). Deliberately not `importedAt`, which means "when
   * the import ran" — a tab set captured years ago and imported today has two
   * different, both useful, dates.
   */
  sessionDate?: number;
}

/**
 * A tag the source stated outright — the title someone typed on a Chrome tab group —
 * as opposed to one inferred from a folder path.
 *
 * Deliberately kept separate from `folderPath`. The folder rules exist to clean up a
 * *filing tree*: they drop containers, strip date stamps, and qualify names that appear
 * under more than one parent. None of that applies to a label a person wrote on purpose,
 * and running it through anyway would both delete good tags (a group named "Feb03") and
 * split one group across windows into `Window 3 · Research` and `Window 5 · Research`.
 */
export interface SourceTag {
  name: string;
  /** A token name from `TAG_COLORS`. Omitted means derive one from the name. */
  color?: string;
}

/**
 * What an importer's parser produces, before any tagging happens.
 *
 * `folderPath` is **raw**: noise filtering and tag qualification are `folder-tags.ts`'s
 * job, and they need the whole corpus to decide (a name is only ambiguous relative to
 * every other path). Parsers therefore stay dumb — they read a source format and stop.
 */
export interface RawEntry {
  url: string;
  title: string;
  dateAdded?: number;
  folderPath: string[];
  /** Chrome's own bookmark node id, when the source had one. */
  chromeId?: string;
  /** Tags stated by the source itself; bypasses the folder rules. See `SourceTag`. */
  sourceTags?: readonly SourceTag[];
  /** tab-import: which window the tab was in. */
  windowId?: number;
  /** tab-import: title of the enclosing tab group, when it had one. */
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
  status: BookmarkStatus;
  source: SourceMeta;
}

export interface Tag {
  id: string;
  name: string;
  /** CSS colour token or hex. Carried over from Chrome tab-group colours on import. */
  color: string;
  /**
   * Tag id of the general form, when this tag is a parent-qualified variant.
   *
   * Import deliberately refuses to merge two folders that share a name — the same name
   * under two different parents is usually not the same subject — so it emits one
   * qualified tag per parent *and* the general tag alongside. The qualified tag keeps
   * the plain name and points here.
   *
   * A tag id, not a name, so renaming the general tag never orphans its children.
   */
  parent?: string;
}

export interface Filters {
  tags?: string[];
  /** `all` = must have every listed tag; `any` = at least one. Defaults to `all`. */
  tagMode?: 'all' | 'any';
  domains?: string[];
  /** Defaults to `['active']` so inbox and archived stay out of the way. */
  status?: BookmarkStatus[];
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

/**
 * Everything a full-fidelity JSON backup carries.
 *
 * Records go in and come out verbatim — ids, notes, status, open counts, `Tag.parent` —
 * which is the whole difference between a restore and an import. Nothing derived is
 * carried: the `meta` store holds only a first-run marker (an inference, not data) and
 * the search index (rebuildable from the records, and a stale second copy of the truth
 * if stored).
 */
export interface BackupPayload {
  /**
   * Fixed marker, so a JSON file that is simply not ours is rejected on identity rather
   * than by failing some field check further in and reporting a confusing reason.
   */
  format: 'bookmarkguru-backup';
  schemaVersion: number;
  exportedAt: number;
  bookmarks: Bookmark[];
  tags: Tag[];
}

/** Result of any ingest path, shown in the import summary. */
export interface ImportSummary {
  added: number;
  /** Matched an existing record, so deliberately not re-added. */
  alreadySaved: number;
  /** Rejected as unusable (chrome:// URLs, malformed, empty). */
  skipped: number;
  tagsCreated: number;
  /** Landed in the inbox rather than the library — saved tab sets awaiting triage. */
  inboxed: number;
}
