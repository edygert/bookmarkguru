/**
 * Full-fidelity JSON backup: records out, records back in.
 *
 * The other `io/` modules are *importers* — they read a foreign format and hand `RawEntry[]`
 * to `ingest`, which mints ids and derives tags from folder paths. This one deliberately
 * does none of that. `RawEntry` cannot express an id, a note, a status, a favourite, an
 * open count or `Tag.parent`, and `ingest` hardcodes every one of those to a default. A
 * backup routed through it would come back as a fresh import wearing the same URLs, which
 * is exactly the data loss it exists to prevent.
 *
 * So records go out and come back **verbatim**. Nothing is recomputed on the way in either:
 * `normalizedUrl` and `domain` are stored fields, and re-deriving them would mean that a
 * change to `normalizeForDedupe`'s tracking-parameter list silently turned every restore
 * into a migration.
 *
 * Pure, like everything in `core/` — no Solid, no DOM, no `chrome.*`. In particular `Blob`
 * is a DOM API, so this module deals in strings and the caller builds the download, the
 * same shape as `html-import.ts` receiving text from `file.text()`.
 */
import { SCHEMA_VERSION } from '../db/schema';
import type { BackupPayload, Bookmark, Tag } from '../types';

const FORMAT = 'bookmarkguru-backup';

export type ParseResult =
  | { ok: true; payload: BackupPayload }
  | { ok: false; reason: string };

/**
 * Serialize the whole library.
 *
 * Pretty-printed, which roughly doubles the file size. Worth it: a backup's whole value is
 * that you can trust it, and the only way to check is to open it and look for a note you
 * know you wrote. A single-line 4 MB file cannot be checked by eye at all.
 */
export function serializeBackup(
  bookmarks: readonly Bookmark[],
  tags: readonly Tag[],
  now = Date.now(),
): string {
  const payload: BackupPayload = {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    bookmarks: [...bookmarks],
    tags: [...tags],
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Validate a backup file before a single record is written.
 *
 * The realistic mistake is picking the wrong file, so the checks are about identity, not
 * about auditing every field: a file that says it is ours, at a version we read, with both
 * arrays present, is trusted the rest of the way. Deeper per-record validation would buy
 * little — the records came out of this same build's `Bookmark` type — and every rule added
 * here is a rule that can wrongly reject someone's only copy of their library.
 */
export function parseBackup(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Not a JSON file.' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'Not a BookmarkGuru backup.' };
  }

  const candidate = parsed as Partial<BackupPayload>;

  // Checked before the version, so a foreign JSON that happens to carry a `schemaVersion`
  // is still reported as the wrong file rather than as the wrong version of the right one.
  if (candidate.format !== FORMAT) {
    return { ok: false, reason: 'Not a BookmarkGuru backup.' };
  }

  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `This backup is schema version ${String(candidate.schemaVersion)}; ` +
        `this build reads version ${SCHEMA_VERSION}.`,
    };
  }

  if (!Array.isArray(candidate.bookmarks) || !Array.isArray(candidate.tags)) {
    return { ok: false, reason: 'Backup is missing its bookmarks or tags.' };
  }

  return {
    ok: true,
    payload: {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      // Display only — a file with a mangled timestamp is still worth restoring, so this
      // falls back rather than rejecting.
      exportedAt: typeof candidate.exportedAt === 'number' ? candidate.exportedAt : 0,
      bookmarks: candidate.bookmarks,
      tags: candidate.tags,
    },
  };
}
