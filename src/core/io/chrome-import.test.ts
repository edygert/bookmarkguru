import { describe, it, expect } from 'vitest';
import { chromeTreeToBookmarks, type BookmarkTreeNodeLike } from './chrome-import';

/** Mirrors Chrome's real shape: root '0' → bar '1' / other '2'. */
function tree(children: BookmarkTreeNodeLike[]): BookmarkTreeNodeLike[] {
  return [{ id: '0', title: '', children }];
}

const NOW = 1_700_000_000_000;

describe('chromeTreeToBookmarks', () => {
  it('turns nested folders into tags and keeps the original path', () => {
    const result = chromeTreeToBookmarks(
      tree([
        {
          id: '1',
          title: 'Bookmarks bar',
          children: [
            {
              id: '10',
              title: 'Dev',
              children: [
                {
                  id: '11',
                  title: 'Tools',
                  children: [
                    { id: '12', title: 'Ripgrep', url: 'https://github.com/BurntSushi/ripgrep' },
                  ],
                },
              ],
            },
          ],
        },
      ]),
      { now: NOW },
    );

    expect(result.bookmarks).toHaveLength(1);
    const bm = result.bookmarks[0]!;
    // 'Bookmarks bar' is a synthetic root and must not become a tag.
    expect(bm.tags).toEqual(['tag:dev', 'tag:tools']);
    expect(bm.source.originalFolderPath).toBe('Dev/Tools');
    expect(bm.source.kind).toBe('chrome-import');
    expect(result.tags.map((t) => t.name).sort()).toEqual(['Dev', 'Tools']);
  });

  it('skips synthetic roots by id, not by localised title', () => {
    // A German profile: titles differ, ids do not.
    const result = chromeTreeToBookmarks(
      tree([
        { id: '1', title: 'Lesezeichenleiste', children: [
          { id: '20', title: 'Arbeit', children: [
            { id: '21', title: 'Wiki', url: 'https://wiki.example.com' },
          ]},
        ]},
      ]),
      { now: NOW },
    );
    expect(result.bookmarks[0]!.tags).toEqual(['tag:arbeit']);
  });

  it('unions tags when the same URL is filed in two folders', () => {
    const result = chromeTreeToBookmarks(
      tree([
        { id: '1', title: 'Bookmarks bar', children: [
          { id: '30', title: 'Reading', children: [
            { id: '31', title: 'Article', url: 'https://example.com/post' },
          ]},
          { id: '40', title: 'Research', children: [
            { id: '41', title: 'Article', url: 'https://example.com/post' },
          ]},
        ]},
      ]),
      { now: NOW },
    );

    // The tree could not express "in both"; tags can.
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]!.tags.sort()).toEqual(['tag:reading', 'tag:research']);
    expect(result.summary.alreadySaved).toBe(1);
  });

  it('collapses URLs differing only by tracking params', () => {
    const result = chromeTreeToBookmarks(
      tree([
        { id: '1', title: 'Bookmarks bar', children: [
          { id: '50', title: 'A', url: 'https://example.com/x?utm_source=news' },
          { id: '51', title: 'B', url: 'https://example.com/x' },
        ]},
      ]),
      { now: NOW },
    );
    expect(result.bookmarks).toHaveLength(1);
  });

  it('skips browser-internal URLs', () => {
    const result = chromeTreeToBookmarks(
      tree([
        { id: '1', title: 'Bookmarks bar', children: [
          { id: '60', title: 'Extensions', url: 'chrome://extensions' },
          { id: '61', title: 'Real', url: 'https://example.com' },
        ]},
      ]),
      { now: NOW },
    );
    expect(result.bookmarks).toHaveLength(1);
    expect(result.summary.skipped).toBe(1);
  });

  it('preserves dateAdded as createdAt and falls back to now', () => {
    const result = chromeTreeToBookmarks(
      tree([
        { id: '1', title: 'Bookmarks bar', children: [
          { id: '70', title: 'Old', url: 'https://old.example.com', dateAdded: 123 },
          { id: '71', title: 'New', url: 'https://new.example.com' },
        ]},
      ]),
      { now: NOW },
    );
    expect(result.bookmarks.find((b) => b.domain === 'old.example.com')!.createdAt).toBe(123);
    expect(result.bookmarks.find((b) => b.domain === 'new.example.com')!.createdAt).toBe(NOW);
  });

  it('falls back to the URL when a bookmark has no title', () => {
    const result = chromeTreeToBookmarks(
      tree([{ id: '1', title: 'Bookmarks bar', children: [
        { id: '80', title: '   ', url: 'https://untitled.example.com' },
      ]}]),
      { now: NOW },
    );
    expect(result.bookmarks[0]!.title).toBe('https://untitled.example.com');
  });

  it('produces stable tag colours across runs', () => {
    const build = () => chromeTreeToBookmarks(
      tree([{ id: '1', title: 'Bookmarks bar', children: [
        { id: '90', title: 'Dev', children: [{ id: '91', title: 'X', url: 'https://x.example.com' }] },
      ]}]),
      { now: NOW },
    );
    expect(build().tags[0]!.color).toBe(build().tags[0]!.color);
  });

  it('handles an empty tree without throwing', () => {
    const result = chromeTreeToBookmarks(tree([]), { now: NOW });
    expect(result.bookmarks).toEqual([]);
    expect(result.summary.added).toBe(0);
  });
});
