import { describe, it, expect } from 'vitest';
import { parseBackup, serializeBackup } from './json-backup';
import { SCHEMA_VERSION } from '../db/schema';
import type { Bookmark, Tag } from '../types';

/**
 * A backup's only job is to come back identical. So most of these tests are fidelity
 * assertions on fields `ingest` would have thrown away — notes, status, favourites, ids —
 * because those are exactly what distinguishes a restore from re-importing the same URLs.
 *
 * Fixtures are synthetic and abstract, per the same rule the rest of `io/` follows.
 */

const NOW = 1_700_000_000_000;

/** Every field populated with a *non-default* value, so a dropped field cannot pass. */
const RECORD: Bookmark = {
  id: 'bm:fixture',
  url: 'https://h1.example.com/page?x=1#frag',
  normalizedUrl: 'https://h1.example.com/page',
  domain: 'h1.example.com',
  title: 'A title',
  description: 'A description',
  notes: 'A note that only exists here.',
  tags: ['tag:p1', 'tag:p1/shared'],
  createdAt: 1_600_000_000_000,
  updatedAt: 1_650_000_000_000,
  lastOpenedAt: 1_690_000_000_000,
  openCount: 7,
  favorite: true,
  pinned: true,
  status: 'archived',
  source: {
    kind: 'chrome-import',
    importedAt: 1_600_000_000_000,
    originalFolderPath: 'P1/SHARED',
    chromeId: '42',
    sessionDate: 1_500_000_000_000,
  },
};

const TAGS: Tag[] = [
  { id: 'tag:p1', name: 'P1', color: 'slate' },
  { id: 'tag:shared', name: 'SHARED', color: 'indigo' },
  { id: 'tag:p1/shared', name: 'SHARED', color: 'indigo', parent: 'tag:p1' },
];

const roundTrip = (bookmarks: readonly Bookmark[], tags: readonly Tag[]) => {
  const result = parseBackup(serializeBackup(bookmarks, tags, NOW));
  if (!result.ok) throw new Error(`expected a valid backup, got: ${result.reason}`);
  return result.payload;
};

describe('round trip', () => {
  it('returns every bookmark field unchanged, id included', () => {
    // Deep equality on the whole record rather than field-by-field: a field added to
    // `Bookmark` later must fail here until it is carried, which naming fields cannot do.
    expect(roundTrip([RECORD], TAGS).bookmarks).toEqual([RECORD]);
  });

  it('keeps a null lastOpenedAt null rather than dropping it', () => {
    // `undefined` disappears through JSON, so a record that has never been opened is the
    // one shape where a silent loss would look like valid data on the way back in.
    const never: Bookmark = { ...RECORD, lastOpenedAt: null };
    expect(roundTrip([never], TAGS).bookmarks[0]!.lastOpenedAt).toBeNull();
  });

  it('keeps a parent-qualified tag and its general form as separate records', () => {
    // Two of the fixture tags deliberately share the name SHARED. A format keyed by name
    // would collapse them, and nothing in a restored record would say they were separate.
    const tags = roundTrip([RECORD], TAGS).tags;
    expect(tags).toEqual(TAGS);
    expect(tags.filter((t) => t.name === 'SHARED')).toHaveLength(2);
  });

  it('does not recompute normalizedUrl or domain', () => {
    // Deliberately inconsistent with what normalizeForDedupe would produce today. If a
    // restore re-derived these, a change to the tracking-parameter list would rewrite
    // every record it touched — a migration wearing a restore's name.
    const stale: Bookmark = { ...RECORD, normalizedUrl: 'https://stale/', domain: 'stale' };
    const back = roundTrip([stale], [])!.bookmarks[0]!;
    expect(back.normalizedUrl).toBe('https://stale/');
    expect(back.domain).toBe('stale');
  });

  it('handles an empty library', () => {
    const payload = roundTrip([], []);
    expect(payload.bookmarks).toEqual([]);
    expect(payload.tags).toEqual([]);
  });

  it('stamps the export time and the schema version', () => {
    const payload = roundTrip([RECORD], TAGS);
    expect(payload.exportedAt).toBe(NOW);
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('rejection', () => {
  const reasonFor = (text: string) => {
    const result = parseBackup(text);
    if (result.ok) throw new Error('expected a rejection');
    return result.reason;
  };

  it('rejects text that is not JSON', () => {
    expect(reasonFor('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe('Not a JSON file.');
  });

  it('rejects JSON that is not an object', () => {
    expect(reasonFor('[1, 2, 3]')).toBe('Not a BookmarkGuru backup.');
    expect(reasonFor('null')).toBe('Not a BookmarkGuru backup.');
  });

  it('rejects a foreign JSON file', () => {
    expect(reasonFor('{"hello":"world"}')).toBe('Not a BookmarkGuru backup.');
  });

  it('reports the wrong file, not the wrong version, when both are wrong', () => {
    // A foreign file carrying its own `schemaVersion` must not be reported as a backup
    // from a different build — that sends you looking for an older release.
    const foreign = JSON.stringify({ schemaVersion: 99, bookmarks: [], tags: [] });
    expect(reasonFor(foreign)).toBe('Not a BookmarkGuru backup.');
  });

  it('rejects a backup written by a different schema version', () => {
    const older = serializeBackup([RECORD], TAGS, NOW).replace(
      `"schemaVersion": ${SCHEMA_VERSION}`,
      '"schemaVersion": 0',
    );
    expect(reasonFor(older)).toContain('schema version 0');
    expect(reasonFor(older)).toContain(`version ${SCHEMA_VERSION}`);
  });

  it('rejects a backup missing either array', () => {
    const missing = JSON.stringify({
      format: 'bookmarkguru-backup',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: NOW,
      tags: [],
    });
    expect(reasonFor(missing)).toBe('Backup is missing its bookmarks or tags.');
  });

  it('accepts a backup whose timestamp is unusable rather than rejecting it', () => {
    // The date is shown, not acted on. Refusing to restore real records over a mangled
    // display field would be the validator destroying the thing it exists to protect.
    const mangled = serializeBackup([RECORD], TAGS, NOW).replace(
      `"exportedAt": ${NOW}`,
      '"exportedAt": "yesterday"',
    );
    const result = parseBackup(mangled);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.bookmarks).toEqual([RECORD]);
  });
});
