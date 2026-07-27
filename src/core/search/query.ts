import { normalizeForMatch } from '../normalize-url';
import type { Bookmark, Filters, SortSpec } from '../types';

/**
 * The read pipeline: text match → filter → sort.
 *
 * Phase 1 does text matching by substring. Phase 2 swaps in MiniSearch by passing a
 * `scores` map; everything downstream is unchanged, which is the point of keeping the
 * stages separate. Pure and synchronous, so it is trivially testable and can run
 * inside a memo without any async plumbing.
 */

export interface QueryInput {
  bookmarks: readonly Bookmark[];
  query: string;
  filters: Filters;
  sort: SortSpec;
  /** Normalized URLs currently open in a tab; required for the `openNow` filter. */
  openUrls?: ReadonlySet<string>;
  /**
   * Tag id → display name. Bookmarks store tag *ids*, but people search by name,
   * so text matching needs the lookup to resolve them.
   */
  tagNames?: ReadonlyMap<string, string>;
  /**
   * Optional relevance scores by bookmark id. When present, these replace substring
   * matching and enable `sort: relevance`. Supplied by the search index in Phase 2.
   */
  scores?: ReadonlyMap<string, number>;
}

/** Substring match across the fields a person would actually recall. */
function matchesText(bookmark: Bookmark, needle: string, tagNames: ReadonlyMap<string, string>): boolean {
  if (bookmark.title.toLowerCase().includes(needle)) return true;
  if (bookmark.url.toLowerCase().includes(needle)) return true;
  if (bookmark.notes.toLowerCase().includes(needle)) return true;
  if (bookmark.description.toLowerCase().includes(needle)) return true;
  return bookmark.tags.some((id) => tagNames.get(id)?.toLowerCase().includes(needle));
}

function matchesFilters(
  bookmark: Bookmark,
  filters: Filters,
  openUrls: ReadonlySet<string> | undefined,
): boolean {
  // Default to active only, so inbox and archived stay out of the way unless asked for.
  const statuses = filters.status ?? ['active'];
  if (!statuses.includes(bookmark.status)) return false;

  if (filters.favorite === true && !bookmark.favorite) return false;

  if (filters.domains?.length && !filters.domains.includes(bookmark.domain)) return false;

  if (filters.tags?.length) {
    const mode = filters.tagMode ?? 'all';
    const has = (id: string) => bookmark.tags.includes(id);
    if (mode === 'all' ? !filters.tags.every(has) : !filters.tags.some(has)) return false;
  }

  if (filters.openNow === true) {
    if (!openUrls?.has(normalizeForMatch(bookmark.url))) return false;
  }

  return true;
}

function compare(a: Bookmark, b: Bookmark, sort: SortSpec, scores?: ReadonlyMap<string, number>): number {
  const dir = sort.dir === 'asc' ? 1 : -1;

  switch (sort.field) {
    case 'title':
      return dir * a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    case 'domain':
      // Same-domain items read better grouped by title than in arbitrary order.
      return dir * (a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));
    case 'createdAt':
      return dir * (a.createdAt - b.createdAt);
    case 'openCount':
      return dir * (a.openCount - b.openCount);
    case 'lastOpenedAt':
      // Never-opened sorts last under 'desc' rather than jumbling in as 0.
      return dir * ((a.lastOpenedAt ?? -Infinity) - (b.lastOpenedAt ?? -Infinity));
    case 'relevance': {
      const diff = (scores?.get(b.id) ?? 0) - (scores?.get(a.id) ?? 0);
      // Ties fall back to recency so ordering stays stable and useful.
      return diff !== 0 ? diff : b.createdAt - a.createdAt;
    }
  }
}

export function runQuery(input: QueryInput): Bookmark[] {
  const { bookmarks, query, filters, sort, openUrls, scores } = input;
  const needle = query.trim().toLowerCase();

  // Tag ids are stored on bookmarks, but people search by tag *name*.
  const tagNames: ReadonlyMap<string, string> = input.tagNames ?? new Map();

  let out = bookmarks.filter((b) => matchesFilters(b, filters, openUrls));

  if (needle) {
    out = scores
      ? out.filter((b) => scores.has(b.id))
      : out.filter((b) => matchesText(b, needle, tagNames));
  }

  // Relevance is meaningless without a query; fall back to something sensible.
  const effectiveSort: SortSpec =
    sort.field === 'relevance' && !needle ? { field: 'createdAt', dir: 'desc' } : sort;

  return out.sort((a, b) => compare(a, b, effectiveSort, scores));
}
