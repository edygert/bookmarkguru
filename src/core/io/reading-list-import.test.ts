import { describe, it, expect } from 'vitest';
import {
  READING_LIST_TAG,
  readingListToBookmarks,
  readingListToEntries,
  type ReadingListEntryLike,
} from './reading-list-import';
import { ingest } from './ingest';
import { tagIdFromName } from '../ids';

/**
 * The source is flat, so most of what the other importers have to get right does not
 * arise here: there is no tree to walk, no root to detect and no folder path to qualify.
 * What is unique is the **stated tag** every item carries and the **inbox** routing, plus
 * the proof that a bookmark folder of the same name lands on the same tag rather than a
 * second one.
 */

const NOW = 1_700_000_000_000;

let n = 0;
const url = () => `https://h${++n}.example.com/`;
const item = (over: Partial<ReadingListEntryLike> = {}): ReadingListEntryLike =>
  ({ url: url(), title: 'T', ...over });

const READING_LIST_ID = tagIdFromName(READING_LIST_TAG);

describe('readingListToEntries — shape', () => {
  it('states the reading-list tag on every entry', () => {
    const entries = readingListToEntries([item(), item()]);
    for (const entry of entries) {
      expect(entry.sourceTags).toEqual([{ name: READING_LIST_TAG }]);
    }
  });

  /**
   * An empty path is what keeps the folder rules off these entries. They classify noise,
   * strip date stamps and qualify ambiguous names — all of it built for a filing tree,
   * none of it applicable to a list nobody filed.
   */
  it('leaves the folder path empty, so no folder rule can reach it', () => {
    const entries = readingListToEntries([item(), item()]);
    expect(entries.map((e) => e.folderPath)).toEqual([[], []]);
  });

  it('carries the creation time through as the date added', () => {
    const [entry] = readingListToEntries([item({ creationTime: 123 })]);
    expect(entry!.dateAdded).toBe(123);
  });

  it('omits the date added when the entry has no creation time', () => {
    const [entry] = readingListToEntries([item()]);
    expect(entry).not.toHaveProperty('dateAdded');
  });

  it('falls back to the URL when the title is blank', () => {
    const only = url();
    const [entry] = readingListToEntries([{ url: only, title: '   ' }]);
    expect(entry!.title).toBe(only);
  });
});

describe('readingListToBookmarks — routing and tagging', () => {
  it('lands items in the inbox — a read-later list is a triage queue', () => {
    const { bookmarks } = readingListToBookmarks([item(), item()], { now: NOW });
    expect(bookmarks.every((b) => b.status === 'inbox')).toBe(true);
  });

  it('takes an explicit status when the caller supplies one', () => {
    const { bookmarks } = readingListToBookmarks([item()], { now: NOW, status: 'active' });
    expect(bookmarks[0]!.status).toBe('active');
  });

  it('puts the reading-list tag on every record, unqualified', () => {
    const { bookmarks, tags } = readingListToBookmarks([item(), item()], { now: NOW });

    for (const bookmark of bookmarks) expect(bookmark.tags).toEqual([READING_LIST_ID]);
    expect(tags).toEqual([{ id: READING_LIST_ID, name: READING_LIST_TAG }]);
  });

  it('dates a record from the entry, and from now when there is none', () => {
    const { bookmarks } = readingListToBookmarks(
      [item({ creationTime: 123 }), item()],
      { now: NOW },
    );
    expect(bookmarks.map((b) => b.createdAt)).toEqual([123, NOW]);
  });

  it('skips browser-internal URLs and counts them', () => {
    const { bookmarks, summary } = readingListToBookmarks(
      [item({ url: 'chrome://settings' }), item()],
      { now: NOW },
    );
    expect(bookmarks).toHaveLength(1);
    expect(summary.skipped).toBe(1);
  });

  /**
   * The collision case, and the reason this needs no special handling: both collectors
   * derive ids through `tagIdFromName`, so a folder named "Reading List" and the tag this
   * importer states are the same tag by construction. Two tags rendering identically is
   * the unusable outcome, and it cannot arise.
   */
  it('shares one tag with a bookmark folder of the same name', () => {
    const shared = url();
    const { bookmarks, tags } = ingest([
      { url: shared, title: 'T', folderPath: [READING_LIST_TAG] },
      ...readingListToEntries([{ url: shared, title: 'T' }]),
    ], { now: NOW });

    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]!.tags).toEqual([READING_LIST_ID]);
    expect(tags).toHaveLength(1);
  });

  it('reports tagsCreated as the number of tags it actually returns', () => {
    const result = readingListToBookmarks([item(), item()], { now: NOW });
    expect(result.summary.tagsCreated).toBe(result.tags.length);
  });

  it('returns a tag record for every tag id it puts on a bookmark', () => {
    // A dangling id renders as nothing on screen and is counted by no view.
    const result = readingListToBookmarks([item(), item()], { now: NOW });
    const known = new Set(result.tags.map((t) => t.id));
    for (const bookmark of result.bookmarks) {
      for (const id of bookmark.tags) expect(known).toContain(id);
    }
  });

  it('handles an empty reading list without throwing', () => {
    const result = readingListToBookmarks([], { now: NOW });
    expect(result.bookmarks).toEqual([]);
    expect(result.summary.added).toBe(0);
  });
});
