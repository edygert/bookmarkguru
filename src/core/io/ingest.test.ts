import { describe, it, expect } from 'vitest';
import { ingest } from './ingest';
import type { FolderRules } from './folder-tags';
import type { RawEntry } from '../types';

/**
 * Behavioural tests: dedupe, tag union, status routing, and the accounting that ties
 * inputs to outputs. Folder names are abstract — see folder-tags.test.ts for why.
 */

const NOW = 1_700_000_000_000;
const SESSION = 'P_SESSION';
const RULES: FolderRules = { session: [SESSION] };

let n = 0;
/** A distinct URL per call, so tests say "different record" without inventing content. */
const url = () => `https://h${++n}.example.com/`;

function entry(u: string, folderPath: string[] = []): RawEntry {
  return { url: u, title: 'T', folderPath };
}

describe('ingest — accounting', () => {
  it('accounts for every input entry exactly once', () => {
    const dup = url();
    const entries = [
      entry(url(), ['P1']),
      entry(dup, ['P1']),
      entry(dup, ['P2']),        // duplicate → alreadySaved
      entry('chrome://settings'), // uningestable → skipped
    ];
    const { summary } = ingest(entries, { kind: 'html-import', now: NOW });

    expect(summary.added + summary.alreadySaved + summary.skipped).toBe(entries.length);
  });

  it('reports tagsCreated as the number of tags it actually returns', () => {
    const result = ingest(
      [entry(url(), ['P1', 'SHARED']), entry(url(), ['P2', 'SHARED'])],
      { kind: 'html-import', now: NOW },
    );
    expect(result.summary.tagsCreated).toBe(result.tags.length);
  });

  it('counts inboxed from the finished records, not as a running total', () => {
    // A record can be promoted out of the inbox after being counted into it.
    const shared = url();
    const result = ingest(
      [entry(shared, [SESSION]), entry(shared, ['P1'])],
      { kind: 'html-import', now: NOW, rules: RULES },
    );
    const actual = result.bookmarks.filter((b) => b.status === 'inbox').length;
    expect(result.summary.inboxed).toBe(actual);
  });

  it('gives every record a distinct id', () => {
    const result = ingest(
      [entry(url()), entry(url()), entry(url())],
      { kind: 'html-import', now: NOW },
    );
    const ids = result.bookmarks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ingest — dedupe and tag union', () => {
  it('collapses entries that normalize to the same URL', () => {
    const base = url();
    const result = ingest(
      [entry(base, ['P1']), entry(`${base}?utm_source=x`, ['P2'])],
      { kind: 'html-import', now: NOW },
    );
    expect(result.bookmarks).toHaveLength(1);
  });

  it('unions the tags of every copy, losing none', () => {
    const shared = url();
    const paths = [['P1'], ['P2'], ['P3']];
    const result = ingest(
      paths.map((p) => entry(shared, p)),
      { kind: 'html-import', now: NOW },
    );

    expect(result.bookmarks).toHaveLength(1);
    const tags = result.bookmarks[0]!.tags;
    // Every path contributed, and nothing appears twice.
    for (const [name] of paths) expect(tags).toContain(`tag:${name!.toLowerCase()}`);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('unions independently of the order copies appear in', () => {
    const shared = url();
    const forward = ingest(
      [entry(shared, ['P1']), entry(shared, ['P2'])],
      { kind: 'html-import', now: NOW },
    );
    const reverse = ingest(
      [entry(shared, ['P2']), entry(shared, ['P1'])],
      { kind: 'html-import', now: NOW },
    );
    expect(forward.bookmarks[0]!.tags.sort()).toEqual(reverse.bookmarks[0]!.tags.sort());
  });
});

describe('ingest — status routing', () => {
  it('routes a session path to the inbox and a normal path to the library', () => {
    const result = ingest(
      [entry(url(), [SESSION, '2024-03-28']), entry(url(), ['P1'])],
      { kind: 'html-import', now: NOW, rules: RULES },
    );
    const statuses = result.bookmarks.map((b) => b.status).sort();
    expect(statuses).toEqual(['active', 'inbox']);
  });

  /**
   * Being deliberately filed outranks having been open in a tab. Without promotion the
   * outcome would depend on where a URL happened to appear in the file, which is not a
   * property anyone can reason about.
   */
  it('promotes out of the inbox when any copy is filed outside a session', () => {
    const shared = url();
    for (const order of [[SESSION, 'P1'], ['P1', SESSION]] as const) {
      const result = ingest(
        [entry(shared, [order[0]]), entry(shared, [order[1]])],
        { kind: 'html-import', now: NOW, rules: RULES },
      );
      expect(result.bookmarks[0]!.status, order.join(' then ')).toBe('active');
    }
  });

  it('stays in the inbox when every copy is a session copy', () => {
    const shared = url();
    const result = ingest(
      [entry(shared, [SESSION, '2024-03-28']), entry(shared, [SESSION, '2024-04-02'])],
      { kind: 'html-import', now: NOW, rules: RULES },
    );
    expect(result.bookmarks[0]!.status).toBe('inbox');
  });

  it('records capture time separately from import time', () => {
    // Overloading one field would lose both facts.
    const result = ingest(
      [entry(url(), [SESSION, '2024-03-28'])],
      { kind: 'html-import', now: NOW, rules: RULES },
    );
    const { source } = result.bookmarks[0]!;
    expect(source.importedAt).toBe(NOW);
    expect(source.sessionDate).toBeTypeOf('number');
    expect(source.sessionDate).not.toBe(source.importedAt);
  });
});

describe('ingest — record construction', () => {
  it('preserves the raw folder path even where it produced no tags', () => {
    const path = [SESSION, '2024-03-28'];
    const result = ingest([entry(url(), path)], { kind: 'html-import', now: NOW, rules: RULES });
    expect(result.bookmarks[0]!.tags).toEqual([]);
    expect(result.bookmarks[0]!.source.originalFolderPath).toBe(path.join('/'));
  });

  it('prefers a supplied creation date and falls back to the import time', () => {
    const result = ingest(
      [{ url: url(), title: 'T', folderPath: [], dateAdded: 123 }, entry(url())],
      { kind: 'html-import', now: NOW },
    );
    expect(result.bookmarks.map((b) => b.createdAt).sort((a, b) => a - b)).toEqual([123, NOW]);
  });

  it('falls back to the URL when an entry has no usable title', () => {
    const u = url();
    const result = ingest(
      [{ url: u, title: '   ', folderPath: [] }],
      { kind: 'html-import', now: NOW },
    );
    expect(result.bookmarks[0]!.title).toBe(u);
  });

  it('stamps the source kind it was given', () => {
    const result = ingest([entry(url())], { kind: 'chrome-import', now: NOW });
    expect(result.bookmarks[0]!.source.kind).toBe('chrome-import');
  });

  it('handles an empty import without throwing', () => {
    const result = ingest([], { kind: 'html-import', now: NOW });
    expect(result.bookmarks).toEqual([]);
    expect(result.summary.added).toBe(0);
  });
});
