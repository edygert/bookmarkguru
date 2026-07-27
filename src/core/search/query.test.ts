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
    favorite: false,
    pinned: false,
    status: 'active' as BookmarkStatus,
    source: { kind: 'manual' },
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
