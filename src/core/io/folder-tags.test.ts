import { describe, it, expect } from 'vitest';
import {
  classifyFolder,
  createFolderTagger,
  findAmbiguousNames,
  isSessionPath,
  keptPath,
  sessionDateOf,
  DATE_FORMAT_SAMPLES,
  GENERIC_STRUCTURAL,
  type FolderRules,
} from './folder-tags';

/**
 * These tests assert rules and invariants, not vocabulary.
 *
 * Folder names are abstract (`P1`, `SHARED`) for two reasons. Realistic names make a test
 * look like it is checking something when it is only checking one string maps to another,
 * and reaching for realistic names means reaching into a real bookmark tree — which is
 * personal data. Where a literal *is* the rule (date shapes, shipped container names) the
 * test iterates the exported list rather than hand-picking examples.
 */

const NOISE = GENERIC_STRUCTURAL[0]!;

describe('classifyFolder — classification contract', () => {
  it('classifies every shipped container default as structural', () => {
    for (const name of GENERIC_STRUCTURAL) {
      expect(classifyFolder(name)).toBe('structural');
      expect(classifyFolder(name.toUpperCase())).toBe('structural');
    }
  });

  it('recognises every date format it claims to support', () => {
    for (const sample of DATE_FORMAT_SAMPLES) {
      expect(classifyFolder(sample), sample).toBe('date');
    }
  });

  it('treats an unrecognised name as keepable — the rules fail open', () => {
    // Getting this backwards silently deletes tags, so it is the important default.
    expect(classifyFolder('P1')).toBe('keep');
    expect(classifyFolder('a name nothing matches')).toBe('keep');
  });

  it('classifies independently of name length', () => {
    // A "drop names <= 2 chars" rule reads as hygiene and destroys real tags: short
    // names are exactly what languages and tools have. Length must not be a signal.
    for (const name of ['A', 'AB', 'ABC', 'A'.repeat(64)]) {
      expect(classifyFolder(name), name).toBe('keep');
    }
  });

  it('ignores surrounding whitespace and case', () => {
    expect(classifyFolder(`  ${NOISE.toUpperCase()}  `)).toBe('structural');
    expect(classifyFolder('   ')).toBe('structural');
  });

  it('separates course-day dividers from dates regardless of spacing', () => {
    for (const name of ['Day 1', 'Day1', 'DAY 12']) {
      expect(classifyFolder(name), name).toBe('course-day');
    }
  });
});

describe('classifyFolder — configuration contract', () => {
  const rules: FolderRules = {
    structural: ['P1'],
    session: ['P2'],
    sessionPatterns: ['^P3 ?\\d+$'],
  };

  it('ships no session rules, since session names are inherently personal', () => {
    // Everyone invents their own word for "the tabs I had open that day". Guessing would
    // be wrong more often than right, so this stays configuration.
    expect(classifyFolder('P2')).toBe('keep');
    expect(classifyFolder('P3 1')).toBe('keep');
  });

  it('extends the shipped defaults rather than replacing them', () => {
    expect(classifyFolder('P1', rules)).toBe('structural');
    for (const name of GENERIC_STRUCTURAL) {
      expect(classifyFolder(name, rules)).toBe('structural');
    }
  });

  it('applies configured session names and patterns', () => {
    expect(classifyFolder('P2', rules)).toBe('session');
    expect(classifyFolder('P3 1', rules)).toBe('session');
    expect(classifyFolder('p3 1', rules)).toBe('session');
  });

  it('discards a malformed pattern without disabling the valid ones', () => {
    // A hand-edited config should degrade, not take the whole import down.
    const mixed: FolderRules = { sessionPatterns: ['^unclosed([', '^P3 ?\\d+$'] };
    expect(() => classifyFolder('P3 1', mixed)).not.toThrow();
    expect(classifyFolder('P3 1', mixed)).toBe('session');
  });
});

describe('sessionDateOf', () => {
  it('returns a timestamp for every recognised date format', () => {
    for (const sample of DATE_FORMAT_SAMPLES) {
      const ts = sessionDateOf([sample]);
      expect(ts, sample).toBeTypeOf('number');
      expect(Number.isNaN(ts), sample).toBe(false);
    }
  });

  it('reads the first date in the path, not the last', () => {
    const first = sessionDateOf(['2024-03-28'])!;
    expect(sessionDateOf(['2024-03-28', '2024-04-02'])).toBe(first);
  });

  it('returns undefined rather than guessing when no date is present', () => {
    expect(sessionDateOf(['P1', 'P2'])).toBeUndefined();
  });
});

describe('keptPath / isSessionPath', () => {
  it('removes every noise segment and preserves the order of the rest', () => {
    expect(keptPath([NOISE, 'P1', 'Day 1', 'P2', '2024-03-28'])).toEqual(['P1', 'P2']);
  });

  it('detects a session folder at any depth', () => {
    const rules: FolderRules = { session: ['P2'] };
    expect(isSessionPath(['P1', 'P2', 'P3'], rules)).toBe(true);
    expect(isSessionPath(['P1', 'P3'], rules)).toBe(false);
  });
});

describe('findAmbiguousNames — ambiguity is a property of the corpus', () => {
  it('flags a name reached through more than one distinct parent', () => {
    expect(findAmbiguousNames([['P1', 'SHARED'], ['P2', 'SHARED']]).has('shared')).toBe(true);
  });

  it('does not flag a name reached through only one parent', () => {
    const ambiguous = findAmbiguousNames([['P1', 'SHARED'], ['P1', 'OTHER']]);
    expect(ambiguous.has('shared')).toBe(false);
    expect(ambiguous.has('other')).toBe(false);
    expect(ambiguous.has('p1')).toBe(false);
  });

  it('counts all top-level occurrences as one position', () => {
    expect(findAmbiguousNames([['SHARED'], ['SHARED']]).has('shared')).toBe(false);
  });

  /**
   * The subtle one, and the reason filtering must precede this pass: two *different*
   * noise parents reduce to the same position, so the child is not ambiguous. Computing
   * ambiguity on raw paths over-reports.
   */
  it('is computed after noise filtering, not before', () => {
    const noises = GENERIC_STRUCTURAL.slice(0, 2);
    expect(noises.length).toBe(2);
    const ambiguous = findAmbiguousNames(noises.map((n) => [n, 'SHARED']));
    expect(ambiguous.has('shared')).toBe(false);
  });
});

describe('createFolderTagger — emission invariants', () => {
  const CORPUS = [
    ['P1', 'SHARED'],
    ['P2', 'SHARED'],
    ['P1', 'OTHER'],
  ];

  /** Tag every path in the corpus and return the tagger plus all emitted ids. */
  function tagAll(corpus = CORPUS, rules?: FolderRules) {
    const tagger = createFolderTagger(corpus, rules);
    const emitted = corpus.map((p) => tagger.tagsFor(p));
    return { tagger, emitted, all: [...new Set(emitted.flat())] };
  }

  it('emits a general tag for every kept segment', () => {
    const { emitted } = tagAll();
    CORPUS.forEach((path, i) => {
      for (const name of keptPath(path)) {
        expect(emitted[i]).toContain(`tag:${name.toLowerCase()}`);
      }
    });
  });

  it('emits a qualified tag exactly when a name is ambiguous and has a parent', () => {
    const { emitted } = tagAll();
    const ambiguous = findAmbiguousNames(CORPUS);

    CORPUS.forEach((path, i) => {
      const kept = keptPath(path);
      kept.forEach((name, depth) => {
        const shouldQualify = depth > 0 && ambiguous.has(name.toLowerCase());
        const qualified = emitted[i]!.filter((id) => id.includes('/'));
        const hasThis = qualified.some((id) => id.endsWith(`/${name.toLowerCase()}`));
        expect(hasThis, `${name} at depth ${depth}`).toBe(shouldQualify);
      });
    });
  });

  it('never emits an id without a corresponding tag record', () => {
    const { all, tagger } = tagAll();
    const known = new Set(tagger.allTags().map((t) => t.id));
    for (const id of all) expect(known.has(id), id).toBe(true);
  });

  it('never orphans a qualified tag — every parent resolves', () => {
    const { tagger } = tagAll();
    const known = new Set(tagger.allTags().map((t) => t.id));
    for (const tag of tagger.allTags()) {
      if (tag.parent === undefined) continue;
      expect(known.has(tag.parent), tag.id).toBe(true);
    }
  });

  it('gives a qualified tag the same name as its general form', () => {
    const { tagger } = tagAll();
    const byId = new Map(tagger.allTags().map((t) => [t.id, t]));
    for (const tag of tagger.allTags()) {
      if (tag.parent === undefined) continue;
      const general = byId.get(`tag:${tag.name.toLowerCase()}`);
      expect(general?.name, tag.id).toBe(tag.name);
    }
  });

  it('groups senses under a shared general tag while keeping them distinct', () => {
    const { emitted } = tagAll();
    const [first, second] = [emitted[0]!, emitted[1]!];
    const general = first.filter((id) => !id.includes('/'));
    const shared = general.filter((id) => second.includes(id));

    // They share the general tag…
    expect(shared.length).toBeGreaterThan(0);
    // …and each carries a qualified tag the other does not.
    const q1 = first.filter((id) => id.includes('/'));
    const q2 = second.filter((id) => id.includes('/'));
    expect(q1.length).toBe(1);
    expect(q2.length).toBe(1);
    expect(q1[0]).not.toBe(q2[0]);
  });

  it('returns ids that are unique within a single result', () => {
    const { emitted } = tagAll();
    for (const ids of emitted) expect(ids.length).toBe(new Set(ids).size);
  });

  it('is deterministic — repeated calls agree', () => {
    const { tagger } = tagAll();
    for (const path of CORPUS) {
      expect(tagger.tagsFor(path)).toEqual(tagger.tagsFor(path));
    }
  });

  it('emits nothing for a path that is entirely noise', () => {
    const rules: FolderRules = { session: ['P2'] };
    const corpus = [['P2', '2024-03-28', 'Day 1']];
    const tagger = createFolderTagger(corpus, rules);
    expect(tagger.tagsFor(corpus[0]!)).toEqual([]);
  });

  it('does not let noise segments act as parents for qualification', () => {
    // Filtering happens first, so the qualifying parent is the nearest *kept* ancestor.
    const corpus = [['P1', NOISE, 'SHARED'], ['P2', 'SHARED']];
    const tagger = createFolderTagger(corpus);
    const ids = tagger.tagsFor(corpus[0]!);
    expect(ids).toContain('tag:p1/shared');
    expect(ids.some((id) => id.includes(NOISE.toLowerCase()))).toBe(false);
  });
});
