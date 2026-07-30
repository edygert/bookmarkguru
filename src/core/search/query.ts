import { normalizeForMatch } from '../normalize-url';
import type { Bookmark, Filters, SortSpec } from '../types';

/**
 * The read pipeline: text match → filter → sort.
 *
 * Text matching is a scan, not an index. A search engine was investigated and turned down:
 * what one uniquely provides is relevance ranking, which is not wanted yet, and everything
 * else it offers costs an index that has to be rebuilt whenever a page opens and kept in
 * step with every write. The two complaints that actually motivated it — multi-term queries
 * and matching inside words — live in `matchesTerm` below.
 *
 * The `scores` seam is left in place for the day ranking is wanted. It is unused today.
 *
 * Pure and synchronous, so it is trivially testable and can run inside a memo without any
 * async plumbing.
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
   * Optional relevance scores by bookmark id. When present, these replace text matching
   * and enable `sort: relevance`. Nothing supplies these today — see the module comment.
   */
  scores?: ReadonlyMap<string, number>;
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Does `needle` occur in `haystack` at the start of a word?
 *
 * The word-start rule is what stops `cat` dragging in "duplicate" and "education", which a
 * plain `includes` cannot avoid. It loops `indexOf` rather than splitting the haystack into
 * tokens: a match costs one search plus one character test, where tokenizing every field of
 * every record on every keystroke would cost more than the scan it was meant to improve.
 *
 * A term opening with punctuation is exempt. `.org` sits after a letter everywhere it ever
 * appears, so demanding a word boundary would not make it precise — it would make it
 * unmatchable.
 */
function hasTerm(haystack: string, needle: string): boolean {
  const anywhere = !WORD.test(needle[0] ?? '');
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (anywhere || at === 0 || !WORD.test(haystack[at - 1]!)) return true;
    from = at + 1;
  }
}

/** One term, across the fields a person would actually recall. */
function matchesTerm(bookmark: Bookmark, term: string, tagNames: ReadonlyMap<string, string>): boolean {
  // Lowercased per field here rather than hoisted into an array, so a single-term query —
  // by far the common one — still stops at the first field that matches.
  if (hasTerm(bookmark.title.toLowerCase(), term)) return true;
  if (hasTerm(bookmark.url.toLowerCase(), term)) return true;
  if (hasTerm(bookmark.notes.toLowerCase(), term)) return true;
  if (hasTerm(bookmark.description.toLowerCase(), term)) return true;
  return bookmark.tags.some((id) => {
    const name = tagNames.get(id);
    return name !== undefined && hasTerm(name.toLowerCase(), term);
  });
}

/**
 * Every term must match, but they need not match the same field — `rust async` finds a page
 * titled "Async patterns" at doc.rust-lang.org. Treating the query as one literal needle
 * instead, as this used to, meant that page matched neither word order.
 */
function matchesText(
  bookmark: Bookmark,
  terms: readonly string[],
  tagNames: ReadonlyMap<string, string>,
): boolean {
  return terms.every((term) => matchesTerm(bookmark, term, tagNames));
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
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  // Tag ids are stored on bookmarks, but people search by tag *name*.
  const tagNames: ReadonlyMap<string, string> = input.tagNames ?? new Map();

  let out = bookmarks.filter((b) => matchesFilters(b, filters, openUrls));

  if (terms.length > 0) {
    out = scores
      ? out.filter((b) => scores.has(b.id))
      : out.filter((b) => matchesText(b, terms, tagNames));
  }

  // Relevance is meaningless without a query; fall back to something sensible.
  const effectiveSort: SortSpec =
    sort.field === 'relevance' && terms.length === 0 ? { field: 'createdAt', dir: 'desc' } : sort;

  return out.sort((a, b) => compare(a, b, effectiveSort, scores));
}
