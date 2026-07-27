import { describe, it, expect } from 'vitest';
import { findMatchingTab, matchesUrl, openTabUrlSet, type TabLike } from './match';

describe('matchesUrl', () => {
  it('matches across cosmetic differences', () => {
    expect(matchesUrl('HTTPS://Example.com:443/a', 'https://example.com/a')).toBe(true);
    expect(matchesUrl('https://e.com/p?b=2&a=1', 'https://e.com/p?a=1&b=2')).toBe(true);
  });

  it('treats a fragment as a different destination', () => {
    // /guide#install is not /guide — switching to the wrong tab feels broken.
    expect(matchesUrl('https://docs.dev/guide#install', 'https://docs.dev/guide')).toBe(false);
  });

  it('does not match on tracking params being stripped', () => {
    // Conservative: opening a redundant tab beats hijacking the wrong one.
    expect(matchesUrl('https://e.com/p?utm_source=x', 'https://e.com/p')).toBe(false);
  });

  it('never matches empty or unparseable URLs to each other', () => {
    expect(matchesUrl('', '')).toBe(false);
  });
});

describe('findMatchingTab', () => {
  const tabs: TabLike[] = [
    { id: 1, windowId: 10, url: 'https://a.example.com/' },
    { id: 2, windowId: 11, url: 'https://b.example.com/page' },
    { id: 3, windowId: 11, url: undefined },
  ];

  it('finds a tab in another window', () => {
    const hit = findMatchingTab(tabs, 'https://b.example.com/page');
    expect(hit?.id).toBe(2);
    expect(hit?.windowId).toBe(11);
  });

  it('returns undefined when nothing matches', () => {
    expect(findMatchingTab(tabs, 'https://c.example.com')).toBeUndefined();
  });

  it('tolerates tabs with no URL', () => {
    expect(() => findMatchingTab(tabs, 'https://a.example.com')).not.toThrow();
    expect(findMatchingTab(tabs, 'https://a.example.com')?.id).toBe(1);
  });
});

describe('openTabUrlSet', () => {
  it('builds a normalized membership set', () => {
    const set = openTabUrlSet([
      { url: 'HTTPS://Example.com:443/a' },
      { url: undefined },
    ]);
    expect(set.has('https://example.com/a')).toBe(true);
    expect(set.size).toBe(1);
  });
});
