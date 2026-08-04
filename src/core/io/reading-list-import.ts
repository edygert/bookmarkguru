import { ingest, type ImportResult } from './ingest';
import type { BookmarkStatus, RawEntry } from '../types';

export type { ImportResult };

/**
 * Chrome's reading list → our records.
 *
 * The fourth import path, and the flattest: a reading list is a list, with no tree, no
 * folders and no labels anyone typed. There is nothing to mine for tags, so this file
 * states one — `Reading List` — through `sourceTags`, which keeps it clear of the folder
 * rules built for a filing tree.
 *
 * Read-later material is unprocessed by definition, so it lands in the inbox, the same
 * routing tab captures and saved tab sets get. Everything downstream — dedupe, tag union,
 * status routing — is `ingest.ts`, shared with the other three paths.
 */

/** The tag every imported item carries. Exported so the test asserts the same string. */
export const READING_LIST_TAG = 'Reading List';

/** Structural shape of chrome.readingList.ReadingListEntry — no chrome types needed. */
export interface ReadingListEntryLike {
  url: string;
  title: string;
  /** Milliseconds since the epoch, like every other date in the app. */
  creationTime?: number | undefined;
}

export interface ReadingListImportOptions {
  now?: number;
  /** Where items land. A read-later list is a triage queue, hence 'inbox'. */
  status?: BookmarkStatus;
}

/** Flatten the list to entries. Unusable URLs are left for `ingest` to count as skipped. */
export function readingListToEntries(
  entries: readonly ReadingListEntryLike[],
): RawEntry[] {
  return entries.map((entry) => ({
    url: entry.url,
    title: entry.title.trim() || entry.url,
    folderPath: [],
    sourceTags: [{ name: READING_LIST_TAG }],
    ...(entry.creationTime !== undefined && { dateAdded: entry.creationTime }),
  }));
}

export function readingListToBookmarks(
  entries: readonly ReadingListEntryLike[],
  options: ReadingListImportOptions = {},
): ImportResult {
  const { now, status = 'inbox' } = options;

  return ingest(readingListToEntries(entries), {
    status,
    ...(now !== undefined && { now }),
  });
}
