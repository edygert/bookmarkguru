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

/**
 * The one narrowing that is not typed. `tag` matches on id, which is what makes the Tags
 * view's count and the list it drills into the same number — a text search for the name
 * also hits titles, URLs and notes.
 */
describe('tag scope', () => {
  const rust = bm({ title: 'Ownership', tags: ['tag:rust'] });
  const also = bm({ title: 'Async in rust', tags: ['tag:rust', 'tag:async'] });
  const other = bm({ title: 'A rust-free page about rust', tags: ['tag:async'] });
  const items = [rust, also, other];

  it('selects exactly the records carrying the tag', () => {
    const out = runQuery({ bookmarks: items, query: '', filters: { tag: 'tag:rust' }, sort: SORT_NEW });
    expect(out.map((b) => b.title).sort()).toEqual(['Async in rust', 'Ownership']);
  });

  it('does not sweep in records that merely mention the name', () => {
    // The distinction the scope exists for: this record says "rust" twice and carries no
    // such tag, so a text search would include it and the scope must not.
    const out = runQuery({ bookmarks: items, query: '', filters: { tag: 'tag:rust' }, sort: SORT_NEW });
    expect(out).not.toContain(other);
  });

  it('composes with the search box', () => {
    const out = runQuery({ bookmarks: items, query: 'async', filters: { tag: 'tag:rust' }, sort: SORT_NEW });
    expect(out.map((b) => b.title)).toEqual(['Async in rust']);
  });

  it('spans statuses when the caller widens them, matching the tag view\'s count', () => {
    const archived = bm({ title: 'Old', tags: ['tag:rust'], status: 'archived' });
    const out = runQuery({
      bookmarks: [...items, archived],
      query: '',
      filters: { tag: 'tag:rust', status: ['active', 'inbox', 'archived'] },
      sort: SORT_NEW,
    });
    expect(out).toHaveLength(3);
  });

  it('is absent by default, so no view is silently scoped', () => {
    expect(runQuery({ bookmarks: items, query: '', filters: {}, sort: SORT_NEW })).toHaveLength(3);
  });
});

/**
 * There is no domain filter and no tag-name filter: typing is how both are done, so these
 * assertions carry what those controls used to. A failure here is not a cosmetic search
 * miss — it is a capability with nothing else offering it.
 */
describe('narrowing by typing, for everything else', () => {
  const items = [
    bm({ url: 'https://github.com/rust-lang/rust', domain: 'github.com', title: 'Repo' }),
    bm({ url: 'https://docs.rs/serde', domain: 'docs.rs', title: 'Crate' }),
    bm({ url: 'https://blog.rust-lang.org/2024/announcing', domain: 'blog.rust-lang.org',
         title: 'Announcing', tags: ['tag:async'] }),
  ];

  it('narrows to one host, the way the domain filter used to', () => {
    const out = runQuery({ bookmarks: items, query: 'docs.rs', filters: {}, sort: SORT_NEW });
    expect(out.map((b) => b.title)).toEqual(['Crate']);
  });

  it('a host term does not sweep in a different host', () => {
    // `github.com` appears in one URL only. The old filter compared `bookmark.domain`
    // exactly; this compares the URL text, and the guard that keeps it precise is the
    // word-start rule rather than an equality check.
    const out = runQuery({ bookmarks: items, query: 'github.com', filters: {}, sort: SORT_NEW });
    expect(out).toHaveLength(1);
  });

  it('a parent host reaches its subdomains, which the filter could not', () => {
    // The old domain filter stored the full host, so `rust-lang.org` matched nothing and
    // `blog.rust-lang.org` was a separate row. Typing it matches the URL text instead,
    // which is the more useful answer to "everything on rust-lang".
    const out = runQuery({ bookmarks: items, query: 'rust-lang', filters: {}, sort: SORT_NEW });
    expect(out).toHaveLength(2);
  });

  it('narrows to one tag, the way the tag filter used to', () => {
    const out = runQuery({
      bookmarks: items,
      query: 'async',
      filters: {},
      sort: SORT_NEW,
      tagNames: new Map([['tag:async', 'async']]),
    });
    expect(out.map((b) => b.title)).toEqual(['Announcing']);
  });

  it('combines a host and a tag, which needed two controls before', () => {
    // What the `all` mode of the tag filter did, plus the domain filter, in one string:
    // every term must match, and they need not match the same field.
    const out = runQuery({
      bookmarks: items,
      query: 'rust-lang async',
      filters: {},
      sort: SORT_NEW,
      tagNames: new Map([['tag:async', 'async']]),
    });
    expect(out.map((b) => b.title)).toEqual(['Announcing']);
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
