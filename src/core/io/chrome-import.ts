import { ingest, type ImportResult } from './ingest';
import type { FolderRules } from './folder-tags';
import type { BookmarkStatus, RawEntry } from '../types';

export type { ImportResult };

/**
 * Chrome's live bookmark tree → our records.
 *
 * This is the migration bridge, and it runs exactly once by default. Chrome's tree is
 * never the live model and is never written back to.
 *
 * The file is deliberately thin: it walks a tree and emits `RawEntry[]`, and that is all.
 * Folder→tag rules, noise filtering, dedupe and status routing live in `folder-tags.ts`
 * and `ingest.ts`, shared with the HTML importer. The one thing that genuinely cannot be
 * shared is root detection — see `ROOT_FOLDER_IDS`.
 */

/** Structural shape of chrome.bookmarks.BookmarkTreeNode — no chrome types needed. */
export interface BookmarkTreeNodeLike {
  id: string;
  title: string;
  url?: string | undefined;
  dateAdded?: number | undefined;
  children?: BookmarkTreeNodeLike[] | undefined;
}

/**
 * Chrome's synthetic root folders, skipped when building tags.
 *
 * Matched by **id, not title** — the titles ("Bookmarks bar", "Other bookmarks") are
 * localised, so a title check would silently stop working on a non-English profile.
 * Tagging every record with "Bookmarks bar" would be pure noise anyway.
 *
 * Ids exist only in the live API. An HTML export has none, which is why `html-import.ts`
 * identifies its root by the `PERSONAL_TOOLBAR_FOLDER` attribute instead.
 */
const ROOT_FOLDER_IDS = new Set(['0', '1', '2', '3']);

export interface ChromeImportOptions {
  now?: number;
  /** Where imported records land. Chrome bookmarks are deliberate saves, so 'active'. */
  status?: BookmarkStatus;
  /** Exclude Chrome's synthetic roots from the tag set. Default true. */
  skipRootFolders?: boolean;
  /** Folder names specific to this tree; see config/folder-rules.example.json. */
  rules?: FolderRules;
}

/** Flatten the tree to entries, dropping synthetic roots from the recorded path. */
export function chromeTreeToEntries(
  roots: readonly BookmarkTreeNodeLike[],
  skipRootFolders = true,
): RawEntry[] {
  const entries: RawEntry[] = [];

  const visit = (node: BookmarkTreeNodeLike, folderPath: readonly string[]): void => {
    if (node.url === undefined) {
      const isRoot = skipRootFolders && ROOT_FOLDER_IDS.has(node.id);
      const nextPath = isRoot || !node.title.trim()
        ? folderPath
        : [...folderPath, node.title.trim()];
      for (const child of node.children ?? []) visit(child, nextPath);
      return;
    }

    entries.push({
      url: node.url,
      title: node.title,
      folderPath: [...folderPath],
      chromeId: node.id,
      ...(node.dateAdded !== undefined && { dateAdded: node.dateAdded }),
    });
  };

  for (const root of roots) visit(root, []);
  return entries;
}

export function chromeTreeToBookmarks(
  roots: readonly BookmarkTreeNodeLike[],
  options: ChromeImportOptions = {},
): ImportResult {
  const { now, status, skipRootFolders = true, rules } = options;
  return ingest(chromeTreeToEntries(roots, skipRootFolders), {
    kind: 'chrome-import',
    ...(now !== undefined && { now }),
    ...(status !== undefined && { status }),
    ...(rules !== undefined && { rules }),
  });
}
