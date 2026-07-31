import { newId } from '../ids';
import { domainOf, isIngestable, normalizeForDedupe } from '../normalize-url';
import { TagCollector } from '../tags';
import { isSessionPath, sessionDateOf, taggerForEntries, type FolderRules } from './folder-tags';
import type {
  Bookmark, BookmarkStatus, ImportSummary, RawEntry, SourceKind, Tag,
} from '../types';

/**
 * `RawEntry[]` → records. The half of importing that every source format shares.
 *
 * Parsers (chrome tree, Netscape HTML, later JSON) do nothing but read their format and
 * hand over entries. Everything opinionated happens here and in `folder-tags.ts`, so the
 * rules exist once and the two paths cannot drift — which they would, given the rule list
 * runs to three date formats, two structural sets, and a qualification pass.
 */

export interface IngestOptions {
  now?: number;
  kind: SourceKind;
  /** Where ordinary records land. Saved tab sets override this to 'inbox' per record. */
  status?: BookmarkStatus;
  /**
   * Folder names specific to this person's tree. Loaded from `config/folder-rules.json`
   * by the caller — core never reads files.
   */
  rules?: FolderRules;
}

export interface ImportResult {
  bookmarks: Bookmark[];
  tags: Tag[];
  summary: ImportSummary;
}

export function ingest(entries: readonly RawEntry[], options: IngestOptions): ImportResult {
  const { now = Date.now(), kind, status = 'active', rules } = options;

  // Pass one lives here: the tagger needs every path before it can tell which folder
  // names are ambiguous, so it is built over the whole corpus up front.
  const tagger = taggerForEntries(entries, rules);

  // Source-stated tags need no corpus pass — they are not qualified against anything —
  // so they accumulate as we go, in their own collector.
  const stated = new TagCollector();

  const bookmarks: Bookmark[] = [];
  /** normalizedUrl → index, to collapse duplicates *within this import*. */
  const seen = new Map<string, number>();

  let skipped = 0;
  let alreadySaved = 0;

  for (const entry of entries) {
    if (!isIngestable(entry.url)) {
      skipped++;
      continue;
    }

    const normalizedUrl = normalizeForDedupe(entry.url);
    const tags = [
      ...new Set([
        ...tagger.tagsFor(entry.folderPath),
        ...(entry.sourceTags ?? [])
          .map((tag) => stated.add(tag.name, tag.color))
          .filter((id) => id !== ''),
      ]),
    ];

    const session = isSessionPath(entry.folderPath, rules);

    const existingIndex = seen.get(normalizedUrl);
    if (existingIndex !== undefined) {
      // Same URL filed under two folders. Keep one record and union the tags — that is
      // precisely the many-to-many case a single-parent tree could not express, and it
      // is common enough in a real export to be the main source of duplicate records.
      const existing = bookmarks[existingIndex]!;
      existing.tags = [...new Set([...existing.tags, ...tags])];

      // Being deliberately filed outranks having been open in a tab. Without this the
      // result depends on file order: a URL appearing in a session folder *before* its real
      // folder would be stranded in the inbox even though it is plainly library material.
      if (existing.status === 'inbox' && !session) existing.status = status;

      alreadySaved++;
      continue;
    }

    const sessionDate = session ? sessionDateOf(entry.folderPath) : undefined;
    const folderPath = entry.folderPath.join('/');

    seen.set(normalizedUrl, bookmarks.length);
    bookmarks.push({
      id: newId(),
      url: entry.url,
      normalizedUrl,
      domain: domainOf(entry.url),
      title: entry.title.trim() || entry.url,
      description: '',
      notes: '',
      tags,
      createdAt: entry.dateAdded ?? now,
      updatedAt: now,
      lastOpenedAt: null,
      openCount: 0,
      // A saved tab set is a triage queue, not library material. Routing it to the inbox
      // is what stops stale session records diluting the default view.
      status: session ? 'inbox' : status,
      source: {
        kind,
        importedAt: now,
        ...(entry.chromeId !== undefined && { chromeId: entry.chromeId }),
        ...(entry.windowId !== undefined && { windowId: entry.windowId }),
        ...(entry.tabGroup !== undefined && { tabGroup: entry.tabGroup }),
        ...(folderPath.length > 0 && { originalFolderPath: folderPath }),
        ...(sessionDate !== undefined && { sessionDate }),
      },
    });
  }

  // Merged by id: a folder and a tab group can legitimately share a name, and they are
  // the same tag when they do — `tagIdFromName` is what decides that, in both collectors.
  const tags = [...new Map(
    [...tagger.allTags(), ...stated.all()].map((tag) => [tag.id, tag]),
  ).values()];
  // Counted from the finished records, not incremented as we go — a record can be
  // promoted out of the inbox by a later occurrence, and a running total would miss that.
  const inboxed = bookmarks.filter((b) => b.status === 'inbox').length;

  return {
    bookmarks,
    tags,
    summary: { added: bookmarks.length, alreadySaved, skipped, tagsCreated: tags.length, inboxed },
  };
}
