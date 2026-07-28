import { normalizeForMatch } from '../normalize-url';

/**
 * Deciding whether an already-open tab *is* the bookmark you just activated.
 *
 * Kept pure and free of chrome.* so it can be unit-tested without a browser; the
 * service worker passes in whatever `chrome.tabs.query` returned.
 *
 * The bias throughout is conservative. A false negative opens a redundant tab,
 * which is mildly annoying. A false positive yanks you to the *wrong* tab, which
 * feels broken. So v1 ships exact-normalized matching only, and looser strategies
 * are added deliberately rather than assumed.
 */

/**
 * Anything with a URL. Structural so tests need no chrome types.
 *
 * Matching only ever reads `url`. The rest is here because this is the one place that
 * describes the shape of a tab, and the open-tabs view and `io/tabs-import.ts` need
 * somewhere to agree on it — a second near-identical `TabLike` would drift.
 */
export interface TabLike {
  id?: number | undefined;
  windowId?: number;
  url?: string | undefined;
  title?: string | undefined;
  /** chrome.tabs.Tab.groupId. Chrome uses -1 for "not in a group", never undefined. */
  groupId?: number;
  /** Position within its window, for listing tabs in the order they appear. */
  index?: number;
}

export interface MatchStrategy {
  name: string;
  /** Both arguments are raw URLs; each strategy normalizes as it sees fit. */
  matches(candidateUrl: string, targetUrl: string): boolean;
}

/**
 * v1: identical once scheme/host case, default ports, and param order are settled.
 * Fragments and tracking params are preserved — `/guide#install` is a different
 * destination from `/guide`.
 */
export const exactNormalized: MatchStrategy = {
  name: 'exact-normalized',
  matches: (candidate, target) => {
    const a = normalizeForMatch(candidate);
    return a !== '' && a === normalizeForMatch(target);
  },
};

/**
 * The ordered strategy list. Extending matching means adding an entry here —
 * e.g. `ignoreFragment`, `ignoreTrackingParams`, `sameOriginAndPath` — and the
 * order expresses precedence, strictest first.
 */
export const STRATEGIES: readonly MatchStrategy[] = [exactNormalized];

export function matchesUrl(
  candidateUrl: string,
  targetUrl: string,
  strategies: readonly MatchStrategy[] = STRATEGIES,
): boolean {
  return strategies.some((s) => s.matches(candidateUrl, targetUrl));
}

/**
 * First tab matching `targetUrl`, or undefined.
 *
 * Strategies are tried outermost-first so a strict hit always beats a loose one:
 * with multiple strategies, every tab is tested against strategy 1 before any tab
 * is tested against strategy 2.
 */
export function findMatchingTab<T extends TabLike>(
  tabs: readonly T[],
  targetUrl: string,
  strategies: readonly MatchStrategy[] = STRATEGIES,
): T | undefined {
  for (const strategy of strategies) {
    const hit = tabs.find((t) => t.url && strategy.matches(t.url, targetUrl));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Normalized URLs of every open tab, for the "open now" badge and filter.
 * A Set because the list re-renders on every tab event and membership must be O(1).
 */
export function openTabUrlSet(tabs: readonly TabLike[]): Set<string> {
  const set = new Set<string>();
  for (const tab of tabs) {
    if (tab.url) set.add(normalizeForMatch(tab.url));
  }
  return set;
}
