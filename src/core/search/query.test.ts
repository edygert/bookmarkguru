import { describe, it, expect } from 'vitest';
import { runQuery } from './query';
import type { Bookmark, BookmarkStatus } from '../types';

let seq = 0;
function bm(over: Partial<Bookmark> = {}): Bookmark {
  seq++;
  return {
    id: `id-${seq}`,
    url: `https://example.com/${seq}`,
    normalizedUrl: `https://example.com/${seq}`,
    domain: 'example.com',
    title: `Item ${seq}`,
    description: '',
    notes: '',
    tags: [],
    createdAt: seq,
    updatedAt: seq,
    lastOpenedAt: null,
    openCount: 0,
    status: 'active' as BookmarkStatus,
    source: {},
    ...over,
  };
}

const SORT_NEW = { field: 'createdAt', dir: 'desc' } as const;

describe('status filtering', () => {
  it('shows only active bookmarks by default', () => {
    const out = runQuery({
      bookmarks: [bm({ status: 'active' }), bm({ status: 'inbox' }), bm({ status: 'archived' })],
      query: '',
      filters: {},
      sort: SORT_NEW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('active');
  });

  it('shows the inbox only when asked for it', () => {
    const items = [bm({ status: 'active' }), bm({ status: 'inbox' })];
    const out = runQuery({ bookmarks: items, query: '', filters: { status: ['inbox'] }, sort: SORT_NEW });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('inbox');
  });
});

describe('text matching', () => {
  const items = [
    bm({ title: 'Rust ownership guide', url: 'https://doc.rust-lang.org/book' }),
    bm({ title: 'Unrelated', notes: 'mentions ownership in passing' }),
    bm({ title: 'Nothing relevant' }),
  ];

  it('matches title, url, and notes', () => {
    expect(runQuery({ bookmarks: items, query: 'ownership', filters: {}, sort: SORT_NEW })).toHaveLength(2);
    expect(runQuery({ bookmarks: items, query: 'rust-lang', filters: {}, sort: SORT_NEW })).toHaveLength(1);
  });

  it('is case insensitive', () => {
    expect(runQuery({ bookmarks: items, query: 'RUST', filters: {}, sort: SORT_NEW })).toHaveLength(1);
  });

  it('matches tag names, not tag ids', () => {
    const tagged = [bm({ tags: ['tag:rust'] }), bm({ tags: ['tag:python'] })];
    const out = runQuery({
      bookmarks: tagged,
      query: 'rust',
      filters: {},
      sort: SORT_NEW,
      tagNames: new Map([['tag:rust', 'Rust'], ['tag:python', 'Python']]),
    });
    expect(out).toHaveLength(1);
  });

  it('returns everything when the query is blank', () => {
    expect(runQuery({ bookmarks: items, query: '   ', filters: {}, sort: SORT_NEW })).toHaveLength(3);
  });
});

describe('multi-term queries', () => {
  const find = (bookmarks: Bookmark[], query: string) =>
    runQuery({ bookmarks, query, filters: {}, sort: SORT_NEW });

  it('matches terms in any order', () => {
    // The whole point: as one literal needle, "rust async" matched neither word order.
    const item = bm({ title: 'Async Rust' });
    expect(find([item], 'rust async')).toHaveLength(1);
    expect(find([item], 'async rust')).toHaveLength(1);
  });

  it('lets terms match different fields', () => {
    const item = bm({ title: 'Async patterns', url: 'https://doc.rust-lang.org/book' });
    expect(find([item], 'rust async')).toHaveLength(1);
  });

  it('requires every term, not just one', () => {
    const item = bm({ title: 'Rust ownership' });
    expect(find([item], 'rust')).toHaveLength(1);
    expect(find([item], 'rust async')).toHaveLength(0);
  });

  it('collapses runs of whitespace rather than making empty terms', () => {
    // '  '.split(/\s+/) yields empty strings, and an empty needle matches everything —
    // so a stray double space would quietly turn the query into a match-all.
    const item = bm({ title: 'Async Rust' });
    expect(find([item], 'rust   async')).toHaveLength(1);
    expect(find([item], '  rust  ')).toHaveLength(1);
  });
});

describe('word boundaries', () => {
  const find = (bookmarks: Bookmark[], query: string) =>
    runQuery({ bookmarks, query, filters: {}, sort: SORT_NEW });

  it('matches the start of a word but not the middle of one', () => {
    const cat = bm({ title: 'Cat' });
    const catalog = bm({ title: 'Catalog of things' });
    const duplicate = bm({ title: 'Duplicate detection' });
    const education = bm({ title: 'Education' });

    expect(find([cat, catalog, duplicate, education], 'cat')).toHaveLength(2);
  });

  it('treats punctuation inside a URL as a boundary', () => {
    // Otherwise a term could only ever match the very start of a URL, since everything
    // after the scheme is separated by punctuation rather than spaces.
    const item = bm({ url: 'https://doc.rust-lang.org/book' });
    expect(find([item], 'lang')).toHaveLength(1);
    expect(find([item], 'book')).toHaveLength(1);
    expect(find([item], 'doc')).toHaveLength(1);
  });

  it('exempts a term that itself begins with punctuation', () => {
    // `.org` follows a letter everywhere it appears, so requiring a boundary before it
    // would not make it precise — it would make it unmatchable.
    const item = bm({ url: 'https://doc.rust-lang.org/book' });
    expect(find([item], '.org')).toHaveLength(1);
    expect(find([item], '-lang')).toHaveLength(1);
  });

  it('finds a later occurrence when the first one is mid-word', () => {
    // 'cat' appears inside "concatenate" before it appears as a word. Bailing on the
    // first hit would report no match on a record that plainly has one.
    const item = bm({ title: 'concatenate', notes: 'about a cat' });
    expect(find([item], 'cat')).toHaveLength(1);
  });

  it('applies the rule to tag names too', () => {
    const tagged = [bm({ tags: ['tag:cat'] }), bm({ tags: ['tag:dup'] })];
    const out = runQuery({
      bookmarks: tagged,
      query: 'cat',
      filters: {},
      sort: SORT_NEW,
      tagNames: new Map([['tag:cat', 'Cat'], ['tag:dup', 'Duplicates']]),
    });
    expect(out).toHaveLength(1);
  });
});

describe('tag filtering', () => {
  const items = [
    bm({ tags: ['a', 'b'] }),
    bm({ tags: ['a'] }),
    bm({ tags: ['c'] }),
  ];

  it('requires every tag in "all" mode', () => {
    const out = runQuery({ bookmarks: items, query: '', filters: { tags: ['a', 'b'] }, sort: SORT_NEW });
    expect(out).toHaveLength(1);
  });

  it('requires at least one tag in "any" mode', () => {
    const out = runQuery({
      bookmarks: items, query: '', filters: { tags: ['a', 'c'], tagMode: 'any' }, sort: SORT_NEW,
    });
    expect(out).toHaveLength(3);
  });
});

describe('domain filtering', () => {
  const items = [
    bm({ domain: 'github.com', title: 'Repo', tags: ['a'] }),
    bm({ domain: 'docs.rs', title: 'Crate', tags: ['a'] }),
    bm({ domain: 'blog.rust-lang.org', title: 'Announcing' }),
  ];

  it('matches exactly one listed domain', () => {
    const out = runQuery({
      bookmarks: items, query: '', filters: { domains: ['docs.rs'] }, sort: SORT_NEW,
    });
    expect(out.map((b) => b.title)).toEqual(['Crate']);
  });

  it('ORs several listed domains together', () => {
    // A record has exactly one domain, so the listed domains partition the result —
    // which is what makes the count beside each sidebar row additive rather than
    // overlapping. The sidebar's arithmetic depends on this.
    const out = runQuery({
      bookmarks: items, query: '', filters: { domains: ['docs.rs', 'github.com'] }, sort: SORT_NEW,
    });
    expect(out).toHaveLength(2);
  });

  it('treats an empty list as no filter, not as "match nothing"', () => {
    // `clearFilters` and `showStatus` both write `domains: []` rather than deleting the
    // key. If that meant "match nothing" they would blank the library instead of
    // restoring it, and every status view would come back empty.
    expect(runQuery({
      bookmarks: items, query: '', filters: { domains: [] }, sort: SORT_NEW,
    })).toHaveLength(3);
  });

  it('matches the full host, never a parent domain', () => {
    // `domainOf` stores the whole host, so these are separate entries in the sidebar
    // and filtering to one must not sweep in the other.
    expect(runQuery({
      bookmarks: items, query: '', filters: { domains: ['rust-lang.org'] }, sort: SORT_NEW,
    })).toHaveLength(0);
  });

  it('ANDs with tags and with the query', () => {
    expect(runQuery({
      bookmarks: items, query: '', filters: { domains: ['github.com'], tags: ['a'] }, sort: SORT_NEW,
    })).toHaveLength(1);

    expect(runQuery({
      bookmarks: items, query: 'crate', filters: { domains: ['github.com'] }, sort: SORT_NEW,
    })).toHaveLength(0);
  });
});

describe('openNow filter', () => {
  it('matches on match-normalization, not the stored dedupe key', () => {
    // The stored normalizedUrl has the fragment stripped; the live tab has it.
    const item = bm({
      url: 'https://docs.dev/guide#install',
      normalizedUrl: 'https://docs.dev/guide',
    });
    const open = new Set(['https://docs.dev/guide#install']);

    expect(runQuery({
      bookmarks: [item], query: '', filters: { openNow: true }, sort: SORT_NEW, openUrls: open,
    })).toHaveLength(1);
  });

  it('excludes bookmarks with no matching tab', () => {
    expect(runQuery({
      bookmarks: [bm()], query: '', filters: { openNow: true }, sort: SORT_NEW, openUrls: new Set(),
    })).toHaveLength(0);
  });
});

describe('sorting', () => {
  it('sorts never-opened last under lastOpenedAt desc', () => {
    const never = bm({ title: 'Never', lastOpenedAt: null });
    const recent = bm({ title: 'Recent', lastOpenedAt: 1000 });
    const out = runQuery({
      bookmarks: [never, recent], query: '', filters: {},
      sort: { field: 'lastOpenedAt', dir: 'desc' },
    });
    expect(out.map((b) => b.title)).toEqual(['Recent', 'Never']);
  });

  it('falls back to recency when relevance is requested without a query', () => {
    const older = bm({ title: 'Older', createdAt: 1 });
    const newer = bm({ title: 'Newer', createdAt: 2 });
    const out = runQuery({
      bookmarks: [older, newer], query: '', filters: {},
      sort: { field: 'relevance', dir: 'desc' },
    });
    expect(out.map((b) => b.title)).toEqual(['Newer', 'Older']);
  });

  it('ranks by score when relevance data is supplied', () => {
    const a = bm({ title: 'Alpha' });
    const b = bm({ title: 'Beta' });
    const out = runQuery({
      bookmarks: [a, b], query: 'x', filters: {},
      sort: { field: 'relevance', dir: 'desc' },
      scores: new Map([[a.id, 1], [b.id, 9]]),
    });
    expect(out.map((x) => x.title)).toEqual(['Beta', 'Alpha']);
  });

  it('restricts results to scored ids when an index is supplied', () => {
    const a = bm();
    const b = bm();
    const out = runQuery({
      bookmarks: [a, b], query: 'x', filters: {}, sort: SORT_NEW,
      scores: new Map([[a.id, 1]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(a.id);
  });
});
