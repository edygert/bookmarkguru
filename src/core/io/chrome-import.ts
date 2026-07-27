import { newId } from '../ids';
import { domainOf, isIngestable, normalizeForDedupe } from '../normalize-url';
import { TagCollector } from '../tags';
import type { Bookmark, BookmarkStatus, ImportSummary, Tag } from '../types';

/**
 * Chrome bookmark tree → our records.
 *
 * This is the migration bridge, and it runs exactly once by default. Chrome's tree is
 * never the live model and is never written back to.
 *
 * The important move: **folders become tags.** A bookmark in `Dev/Tools/Linters` gets
 * the tags `Dev`, `Tools`, `Linters` and keeps the original path in `source` for
 * traceability. That is what converts a single-parent hierarchy into the many-to-many
 * organisation the rest of the app is built on.
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
 */
const ROOT_FOLDER_IDS = new Set(['0', '1', '2', '3']);

export interface ChromeImportOptions {
  now?: number;
  /** Where imported records land. Chrome bookmarks are deliberate saves, so 'active'. */
  status?: BookmarkStatus;
  /** Exclude Chrome's synthetic roots from the tag set. Default true. */
  skipRootFolders?: boolean;
}

export interface ImportResult {
  bookmarks: Bookmark[];
  tags: Tag[];
  summary: ImportSummary;
}

export function chromeTreeToBookmarks(
  roots: readonly BookmarkTreeNodeLike[],
  options: ChromeImportOptions = {},
): ImportResult {
  const {
    now = Date.now(),
    status = 'active',
    skipRootFolders = true,
  } = options;

  const tags = new TagCollector();
  const bookmarks: Bookmark[] = [];
  /** normalizedUrl → index, to collapse duplicates *within this tree*. */
  const seen = new Map<string, number>();

  let skipped = 0;
  let alreadySaved = 0;

  const visit = (node: BookmarkTreeNodeLike, folderPath: readonly string[]): void => {
    if (node.url === undefined) {
      // Folder. Contribute its name to the path unless it's a synthetic root.
      const isRoot = skipRootFolders && ROOT_FOLDER_IDS.has(node.id);
      const nextPath = isRoot || !node.title.trim()
        ? folderPath
        : [...folderPath, node.title.trim()];
      for (const child of node.children ?? []) visit(child, nextPath);
      return;
    }

    if (!isIngestable(node.url)) {
      skipped++;
      return;
    }

    const normalizedUrl = normalizeForDedupe(node.url);
    const tagIds = folderPath.map((name) => tags.add(name)).filter(Boolean);

    const existingIndex = seen.get(normalizedUrl);
    if (existingIndex !== undefined) {
      // Same URL filed under two folders. Keep one record and union the tags —
      // that is exactly the many-to-many case the tree could not express.
      const existing = bookmarks[existingIndex]!;
      existing.tags = [...new Set([...existing.tags, ...tagIds])];
      alreadySaved++;
      return;
    }

    seen.set(normalizedUrl, bookmarks.length);
    bookmarks.push({
      id: newId(),
      url: node.url,
      normalizedUrl,
      domain: domainOf(node.url),
      title: node.title.trim() || node.url,
      description: '',
      notes: '',
      tags: tagIds,
      createdAt: node.dateAdded ?? now,
      updatedAt: now,
      lastOpenedAt: null,
      openCount: 0,
      favorite: false,
      pinned: false,
      status,
      source: {
        kind: 'chrome-import',
        importedAt: now,
        chromeId: node.id,
        ...(folderPath.length > 0 && { originalFolderPath: folderPath.join('/') }),
      },
    });
  };

  for (const root of roots) visit(root, []);

  return {
    bookmarks,
    tags: tags.all(),
    summary: { added: bookmarks.length, alreadySaved, skipped, tagsCreated: tags.size },
  };
}
