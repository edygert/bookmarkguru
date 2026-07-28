import { describe, it, expect } from 'vitest';
import { chromeTreeToBookmarks, chromeTreeToEntries, type BookmarkTreeNodeLike } from './chrome-import';

/**
 * This file walks a tree and stops; dedupe, tag rules and status routing live in
 * ingest.ts and folder-tags.ts and are tested there. What is unique here is **root
 * detection by node id**, which is the one thing the two importers cannot share.
 *
 * Folder names are abstract — realistic ones would only be someone's real bookmark tree.
 */

const NOW = 1_700_000_000_000;

/** Mirrors the real shape: root '0' containing bar '1' and other '2'. */
function tree(children: BookmarkTreeNodeLike[]): BookmarkTreeNodeLike[] {
  return [{ id: '0', title: '', children }];
}

let n = 0;
const url = () => `https://h${++n}.example.com/`;
const link = (id: string, extra: Partial<BookmarkTreeNodeLike> = {}): BookmarkTreeNodeLike =>
  ({ id, title: 'T', url: url(), ...extra });

describe('chromeTreeToEntries — structure', () => {
  it('reconstructs the folder path at every depth', () => {
    const entries = chromeTreeToEntries(tree([
      { id: '1', title: 'ROOT', children: [
        link('10'),
        { id: '11', title: 'P1', children: [
          link('12'),
          { id: '13', title: 'P2', children: [link('14')] },
        ]},
      ]},
    ]));

    expect(entries.map((e) => e.folderPath)).toEqual([[], ['P1'], ['P1', 'P2']]);
  });

  /**
   * The whole reason this importer exists separately. Synthetic roots are identified by
   * id because their titles are localised — a title check silently stops working on a
   * non-English profile, and every record picks up a junk tag.
   */
  it('excludes synthetic roots by id, whatever they are titled', () => {
    const build = (title: string) => chromeTreeToEntries(tree([
      { id: '1', title, children: [{ id: '20', title: 'P1', children: [link('21')] }] },
    ]))[0]!.folderPath;

    expect(build('Bookmarks bar')).toEqual(['P1']);
    expect(build('Lesezeichenleiste')).toEqual(build('Bookmarks bar'));
  });

  it('treats a non-root folder as ordinary even if it shares a root title', () => {
    const entries = chromeTreeToEntries(tree([
      { id: '1', title: 'ROOT', children: [
        { id: '99', title: 'Bookmarks bar', children: [link('100')] },
      ]},
    ]));
    // Only the id decides here; dropping it by name is folder-tags.ts's job.
    expect(entries[0]!.folderPath).toEqual(['Bookmarks bar']);
  });

  it('can be told to keep the synthetic roots', () => {
    const entries = chromeTreeToEntries(
      tree([{ id: '1', title: 'ROOT', children: [link('10')] }]),
      false,
    );
    expect(entries[0]!.folderPath).toEqual(['ROOT']);
  });

  it('ignores folders with no usable name', () => {
    const entries = chromeTreeToEntries(tree([
      { id: '1', title: 'ROOT', children: [{ id: '30', title: '   ', children: [link('31')] }] },
    ]));
    expect(entries[0]!.folderPath).toEqual([]);
  });

  it('carries the node id and creation date through untouched', () => {
    const entries = chromeTreeToEntries(tree([
      { id: '1', title: 'ROOT', children: [link('42', { dateAdded: 123 })] },
    ]));
    expect(entries[0]).toMatchObject({ chromeId: '42', dateAdded: 123 });
  });

  it('handles an empty tree without throwing', () => {
    expect(chromeTreeToEntries(tree([]))).toEqual([]);
  });
});

describe('chromeTreeToBookmarks — composition', () => {
  it('marks records with the chrome-import source kind', () => {
    const result = chromeTreeToBookmarks(
      tree([{ id: '1', title: 'ROOT', children: [link('10')] }]),
      { now: NOW },
    );
    expect(result.bookmarks[0]!.source.kind).toBe('chrome-import');
  });

  it('applies folder tagging to the walked tree', () => {
    const result = chromeTreeToBookmarks(tree([
      { id: '1', title: 'ROOT', children: [
        { id: '10', title: 'P1', children: [
          { id: '11', title: 'P2', children: [link('12')] },
        ]},
      ]},
    ]), { now: NOW });

    expect(result.bookmarks[0]!.tags).toEqual(['tag:p1', 'tag:p2']);
    expect(result.bookmarks[0]!.source.originalFolderPath).toBe('P1/P2');
  });

  it('produces stable tag colours across runs', () => {
    // Re-importing must not reshuffle the palette.
    const build = () => chromeTreeToBookmarks(tree([
      { id: '1', title: 'ROOT', children: [{ id: '10', title: 'P1', children: [
        { id: '11', title: 'T', url: 'https://stable.example.com/' },
      ]}]},
    ]), { now: NOW });
    expect(build().tags[0]!.color).toBe(build().tags[0]!.color);
  });
});
