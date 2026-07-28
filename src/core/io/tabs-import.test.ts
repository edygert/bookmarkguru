import { describe, it, expect } from 'vitest';
import { tabsToBookmarks, tabsToEntries, windowOrdinals, type TabGroupLike } from './tabs-import';
import { tagIdFromName } from '../ids';
import type { TabLike } from '../tabs/match';

/**
 * Behavioural tests for capturing open tabs. Group titles are abstract (`G1`) for the
 * same reason folder names are elsewhere — see folder-tags.test.ts.
 */

const NOW = 1_700_000_000_000;

/** Chrome's sentinel for "this tab is not in a group". Not undefined, and not 0. */
const UNGROUPED = -1;

let n = 0;
const url = () => `https://h${++n}.example.com/`;

function tab(over: Partial<TabLike> = {}): TabLike {
  return { id: ++n, url: url(), title: 'T', windowId: 100, groupId: UNGROUPED, index: 0, ...over };
}

const group = (id: number, title?: string, color?: string): TabGroupLike =>
  ({ id, ...(title !== undefined && { title }), ...(color !== undefined && { color }) });

describe('windowOrdinals', () => {
  it('numbers windows from 1 in id order, not in the order tabs are listed', () => {
    // Chrome hands out increasing window ids, so id order is creation order. Listing
    // order is not something chrome.tabs.query promises.
    const ordinals = windowOrdinals([
      tab({ windowId: 300 }), tab({ windowId: 100 }), tab({ windowId: 200 }),
    ]);
    expect([...ordinals]).toEqual([[100, 1], [200, 2], [300, 3]]);
  });

  it('gives every tab in one window the same number', () => {
    const ordinals = windowOrdinals([tab({ windowId: 7 }), tab({ windowId: 7 })]);
    expect(ordinals.size).toBe(1);
  });
});

describe('tabsToEntries — tagging', () => {
  it('tags a grouped tab with its group title', () => {
    const [entry] = tabsToEntries([tab({ groupId: 5 })], { groups: [group(5, 'G1')] });
    expect(entry!.sourceTags?.map((t) => t.name)).toContain('G1');
  });

  it('carries the Chrome group colour onto the tag', () => {
    const [entry] = tabsToEntries([tab({ groupId: 5 })], { groups: [group(5, 'G1', 'cyan')] });
    expect(entry!.sourceTags?.find((t) => t.name === 'G1')?.color).toBe('cyan');
  });

  it('treats groupId -1 as ungrouped rather than as a group id', () => {
    // The bug this guards: `groupId !== undefined` is true for -1, so a naive lookup
    // would search the group map for -1 on every ungrouped tab.
    const [entry] = tabsToEntries([tab({ groupId: UNGROUPED })], { groups: [group(5, 'G1')] });
    expect(entry!.tabGroup).toBeUndefined();
    expect(entry!.sourceTags?.map((t) => t.name)).not.toContain('G1');
  });

  it('emits no group tag for an untitled group', () => {
    const [entry] = tabsToEntries([tab({ groupId: 5 })], { groups: [group(5, '  ')] });
    expect(entry!.tabGroup).toBeUndefined();
  });

  it('tags each tab with its window ordinal', () => {
    const entries = tabsToEntries([tab({ windowId: 100 }), tab({ windowId: 200 })]);
    expect(entries.map((e) => e.sourceTags?.map((t) => t.name)).flat())
      .toEqual(['Window 1', 'Window 2']);
  });

  it('omits window tags when asked', () => {
    const [entry] = tabsToEntries([tab()], { tagWindows: false });
    expect(entry!.sourceTags).toBeUndefined();
  });

  /**
   * The reason `windowOrdinals` is an option at all. Saving a filtered subset must keep
   * the numbering the user saw, or one window's tabs come back labelled "Window 1".
   */
  it('honours supplied ordinals so a filtered subset keeps its numbering', () => {
    const all = [tab({ windowId: 100 }), tab({ windowId: 200 }), tab({ windowId: 300 })];
    const subset = [all[2]!];

    const [entry] = tabsToEntries(subset, { windowOrdinals: windowOrdinals(all) });
    expect(entry!.sourceTags?.map((t) => t.name)).toEqual(['Window 3']);
  });

  it('renumbers a subset when ordinals are left to default — the trap the option avoids', () => {
    const [entry] = tabsToEntries([tab({ windowId: 300 })]);
    expect(entry!.sourceTags?.map((t) => t.name)).toEqual(['Window 1']);
  });

  it('leaves folderPath empty, so no folder rule can touch a tab', () => {
    const entries = tabsToEntries([tab({ groupId: 5 })], { groups: [group(5, 'Feb03')] });
    expect(entries[0]!.folderPath).toEqual([]);
  });

  it('skips a tab with no URL', () => {
    expect(tabsToEntries([tab({ url: undefined })])).toEqual([]);
  });

  it('falls back to the URL when a tab has no usable title', () => {
    const u = url();
    const [entry] = tabsToEntries([tab({ url: u, title: '  ' })]);
    expect(entry!.title).toBe(u);
  });
});

describe('tabsToBookmarks', () => {
  it('lands captures in the inbox — a tab dump is a triage queue', () => {
    const { bookmarks } = tabsToBookmarks([tab(), tab()], { now: NOW });
    expect(bookmarks.map((b) => b.status)).toEqual(['inbox', 'inbox']);
  });

  it('stamps the tab-import source kind', () => {
    const { bookmarks } = tabsToBookmarks([tab()], { now: NOW });
    expect(bookmarks[0]!.source.kind).toBe('tab-import');
  });

  it('records the window and group on the record, not only as tags', () => {
    const { bookmarks } = tabsToBookmarks(
      [tab({ windowId: 42, groupId: 5 })],
      { now: NOW, groups: [group(5, 'G1')] },
    );
    expect(bookmarks[0]!.source.windowId).toBe(42);
    expect(bookmarks[0]!.source.tabGroup).toBe('G1');
  });

  it('skips browser-internal tabs and counts them', () => {
    const { bookmarks, summary } = tabsToBookmarks(
      [tab({ url: 'chrome://settings' }), tab()],
      { now: NOW },
    );
    expect(bookmarks).toHaveLength(1);
    expect(summary.skipped).toBe(1);
  });

  it('collapses the same URL open in two windows into one record', () => {
    const shared = url();
    const { bookmarks } = tabsToBookmarks(
      [tab({ url: shared, windowId: 100 }), tab({ url: shared, windowId: 200 })],
      { now: NOW },
    );
    expect(bookmarks).toHaveLength(1);
    // Both windows are recorded, because both are true.
    expect(bookmarks[0]!.tags).toEqual(
      expect.arrayContaining([tagIdFromName('Window 1'), tagIdFromName('Window 2')]),
    );
  });

  /**
   * A group tag must stay one tag across windows. Routing group titles through
   * `folderPath` instead would make `G1` ambiguous — it appears under two window
   * "parents" — and split it into qualified variants, which is exactly wrong here.
   */
  it('keeps one group tag when a group name appears in several windows', () => {
    const { bookmarks, tags } = tabsToBookmarks(
      [tab({ windowId: 100, groupId: 5 }), tab({ windowId: 200, groupId: 6 })],
      { now: NOW, groups: [group(5, 'G1'), group(6, 'G1')] },
    );

    expect(tags.filter((t) => t.name === 'G1')).toHaveLength(1);
    for (const bookmark of bookmarks) expect(bookmark.tags).toContain(tagIdFromName('G1'));
    expect(tags.every((t) => t.parent === undefined)).toBe(true);
  });

  it('reports tagsCreated as the number of tags it actually returns', () => {
    const result = tabsToBookmarks(
      [tab({ windowId: 100, groupId: 5 }), tab({ windowId: 200 })],
      { now: NOW, groups: [group(5, 'G1')] },
    );
    expect(result.summary.tagsCreated).toBe(result.tags.length);
  });

  it('returns a tag record for every tag id it puts on a bookmark', () => {
    // A dangling id would render as a missing chip and a sidebar row that never appears.
    const result = tabsToBookmarks(
      [tab({ windowId: 100, groupId: 5 }), tab({ windowId: 200 })],
      { now: NOW, groups: [group(5, 'G1', 'blue')] },
    );
    const known = new Set(result.tags.map((t) => t.id));
    for (const bookmark of result.bookmarks) {
      for (const id of bookmark.tags) expect(known).toContain(id);
    }
  });

  it('handles an empty capture without throwing', () => {
    const result = tabsToBookmarks([], { now: NOW });
    expect(result.bookmarks).toEqual([]);
    expect(result.summary.added).toBe(0);
  });
});
