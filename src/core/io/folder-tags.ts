import { qualifiedTagId, tagIdFromName } from '../ids';
import { colorForTag, TagCollector } from '../tags';
import type { RawEntry, Tag } from '../types';

/**
 * Folder names → tags. The shared rules for every import path.
 *
 * Two jobs, both of which need the *whole* corpus rather than one entry at a time:
 *
 *  1. **Drop noise.** Real bookmark trees are full of folders that describe filing
 *     rather than subject matter: browser containers, date-stamped snapshots, course-day
 *     dividers. None of those are tags.
 *  2. **Qualify ambiguous names instead of merging them.** Deriving a tag id from the
 *     name alone fuses `Cooking/Tools` with `Woodworking/Tools`. Merging is a one-way
 *     door — afterwards nothing records that they were ever separate — so this module
 *     emits BOTH a parent-qualified tag and the general one, and leaves any actual
 *     collapsing to the tag-merge UI, where a human can see what is being joined.
 *
 * Pure data in, pure data out: no DOM, no chrome.*, no Solid, and **no file access** —
 * user rules arrive as an argument (see `FolderRules`), never read from disk here.
 */

// ── user-supplied rules ───────────────────────────────────────────────────────

/**
 * Extra rules for names only a particular person's tree would contain.
 *
 * Session container names are inherently idiosyncratic — everyone invents their own word
 * for "the tabs I had open that day" — so no defaults ship for them. Supply your own via
 * `config/folder-rules.json`, which is gitignored precisely because folder names from a
 * real tree are personal data. See `config/folder-rules.example.json`.
 */
export interface FolderRules {
  /** Filing containers that should not become tags. */
  structural?: readonly string[];
  /** Saved tab sets: not tags, and their contents import to the inbox. */
  session?: readonly string[];
  /** Regular expressions (as strings) matching saved tab sets. */
  sessionPatterns?: readonly string[];
}

interface CompiledRules {
  structural: ReadonlySet<string>;
  session: ReadonlySet<string>;
  sessionPatterns: readonly RegExp[];
}

/**
 * Browser-created containers. These *are* universal, so they ship in code.
 *
 * Note the absence of a bare `Bookmarks` — that is a plausible name for a real folder,
 * and dropping it would be silent data loss.
 */
export const GENERIC_STRUCTURAL: readonly string[] = [
  'imported',
  'unsorted bookmarks',
  'new folder',
  'other bookmarks',
  'mobile bookmarks',
  'bookmarks bar',
  'bookmarks toolbar',
];

/**
 * Format families the date rule recognises. Exported so tests cover whatever ships.
 * Arbitrary dates — these illustrate shapes, not anything anyone actually filed.
 */
export const DATE_FORMAT_SAMPLES: readonly string[] = [
  '1999-01-15',        // ISO, optionally followed by more words
  '1999-01-15 SUFFIX',
  'PREFIX 3-4-21',     // M-D-YY embedded in a longer name
  '7/8/1999',          // M/D/YYYY
  'Jan151999',         // MonDDYYYY
  'Feb03',             // MonDD
  'Nov12-1998',        // MonDD-YYYY
];

const compiledCache = new WeakMap<FolderRules, CompiledRules>();
const DEFAULT_COMPILED: CompiledRules = {
  structural: new Set(GENERIC_STRUCTURAL),
  session: new Set(),
  sessionPatterns: [],
};

function compile(rules?: FolderRules): CompiledRules {
  if (!rules) return DEFAULT_COMPILED;
  const cached = compiledCache.get(rules);
  if (cached) return cached;

  const compiled: CompiledRules = {
    structural: new Set([
      ...GENERIC_STRUCTURAL,
      ...(rules.structural ?? []).map((n) => n.trim().toLowerCase()),
    ]),
    session: new Set((rules.session ?? []).map((n) => n.trim().toLowerCase())),
    // A malformed pattern in a hand-edited config should not take the whole import down.
    sessionPatterns: (rules.sessionPatterns ?? []).flatMap((source) => {
      try {
        return [new RegExp(source, 'i')];
      } catch {
        return [];
      }
    }),
  };
  compiledCache.set(rules, compiled);
  return compiled;
}

// ── generic noise patterns ────────────────────────────────────────────────────

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * Date-stamped folder names. Three distinct shapes, all common in exports that have
 * accumulated tab snapshots — a single pattern silently misses two of them.
 *
 * The third is anchored to real month abbreviations rather than `[A-Z][a-z]{2}\d+`,
 * which would also swallow `Win10`, `Mac11`, `Gen8`… and quietly delete those tags.
 */
const DATE_PATTERNS: readonly RegExp[] = [
  /^(\d{4})-(\d{2})-(\d{2})/,                                    // 2024-03-28 Primary
  /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/,                     // Work 9-9-22
  new RegExp(`^(${MONTHS.join('|')})[a-z]*(\\d{1,2})(?:-?(\\d{4}))?$`, 'i'), // May062011
];

/** Course/class day dividers. Both spellings occur, often in the same export. */
const COURSE_DAY = /^day ?\d+$/i;

export type FolderClass = 'keep' | 'structural' | 'session' | 'date' | 'course-day';

/**
 * What kind of folder is this?
 *
 * ⚠️ There is deliberately **no name-length rule**. "Drop names of two characters or
 * fewer" reads as obvious hygiene and destroys real tags — short names are exactly what
 * languages and tools tend to have. This was tried; it is a trap. See the test.
 */
export function classifyFolder(name: string, rules?: FolderRules): FolderClass {
  const clean = name.trim();
  if (!clean) return 'structural';

  const { structural, session, sessionPatterns } = compile(rules);
  const lower = clean.toLowerCase();

  if (structural.has(lower)) return 'structural';
  if (session.has(lower) || sessionPatterns.some((re) => re.test(clean))) return 'session';
  if (COURSE_DAY.test(clean)) return 'course-day';
  if (DATE_PATTERNS.some((re) => re.test(clean))) return 'date';
  return 'keep';
}

/** Does this path sit inside a saved tab set? Then its contents belong in the inbox. */
export function isSessionPath(folderPath: readonly string[], rules?: FolderRules): boolean {
  return folderPath.some((name) => classifyFolder(name, rules) === 'session');
}

/**
 * Timestamp parsed from the first date-shaped folder in a path, if any.
 *
 * Used for `SourceMeta.sessionDate` — when a tab set was captured, which is a different
 * fact from when we imported it. Returns undefined rather than guessing.
 */
export function sessionDateOf(folderPath: readonly string[]): number | undefined {
  for (const name of folderPath) {
    const clean = name.trim();

    const iso = DATE_PATTERNS[0]!.exec(clean);
    if (iso) return Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!);

    const slashed = DATE_PATTERNS[1]!.exec(clean);
    if (slashed) {
      const year = +slashed[3]!;
      return Date.UTC(year < 100 ? 2000 + year : year, +slashed[1]! - 1, +slashed[2]!);
    }

    const named = DATE_PATTERNS[2]!.exec(clean);
    if (named) {
      const month = MONTHS.indexOf(named[1]!.toLowerCase());
      if (month >= 0) return Date.UTC(named[3] ? +named[3] : 1970, month, +named[2]!);
    }
  }
  return undefined;
}

/** Strip every noise segment, preserving order. */
export function keptPath(folderPath: readonly string[], rules?: FolderRules): string[] {
  return folderPath.map((n) => n.trim()).filter((n) => classifyFolder(n, rules) === 'keep');
}

// ── qualification ─────────────────────────────────────────────────────────────

/** Stands in for "this folder is top-level", so it can live in the same Set as names. */
const TOP_LEVEL = ' top';

/**
 * Which folder names appear under more than one distinct parent.
 *
 * Computed over *filtered* paths, which matters: `Bookmarks bar/Recipes` and
 * `Imported/Recipes` both reduce to a top-level `Recipes`, so `Recipes` is NOT ambiguous
 * even though the raw tree makes it look that way. Computing this before filtering
 * over-reports badly.
 */
export function findAmbiguousNames(
  paths: readonly (readonly string[])[],
  rules?: FolderRules,
): Set<string> {
  const parents = new Map<string, Set<string>>();

  for (const raw of paths) {
    const kept = keptPath(raw, rules);
    kept.forEach((name, i) => {
      const key = name.toLowerCase();
      const parent = i === 0 ? TOP_LEVEL : kept[i - 1]!.toLowerCase();
      const seen = parents.get(key) ?? new Set<string>();
      seen.add(parent);
      parents.set(key, seen);
    });
  }

  const ambiguous = new Set<string>();
  for (const [name, seen] of parents) if (seen.size > 1) ambiguous.add(name);
  return ambiguous;
}

export interface FolderTagger {
  /** Tag ids for one entry's folder path. */
  tagsFor(folderPath: readonly string[]): string[];
  /** Every tag created so far, general and qualified. */
  allTags(): Tag[];
  /** Names that were qualified, for reporting. Lowercased. */
  ambiguousNames(): ReadonlySet<string>;
}

/**
 * Build a tagger over the whole corpus.
 *
 * Two passes are unavoidable: whether `Tools` needs qualifying is a property of every
 * path in the import, not of the entry in front of you. Pass one finds the ambiguous
 * names; `tagsFor` is pass two.
 */
export function createFolderTagger(
  paths: readonly (readonly string[])[],
  rules?: FolderRules,
): FolderTagger {
  const ambiguous = findAmbiguousNames(paths, rules);
  const collector = new TagCollector();
  /** Qualified tags, which TagCollector cannot model (it is keyed by name alone). */
  const qualified = new Map<string, Tag>();

  return {
    tagsFor(folderPath) {
      const kept = keptPath(folderPath, rules);
      const ids: string[] = [];

      kept.forEach((name, i) => {
        // The general tag is always emitted, ambiguous or not. That is what keeps a
        // broad "everything Tools-ish" grouping working even after qualification splits
        // the specific senses apart.
        const generalId = collector.add(name);
        if (generalId) ids.push(generalId);

        if (i === 0 || !ambiguous.has(name.toLowerCase())) return;

        // Ambiguous *and* nested: also emit a tag qualified by its immediate parent, so
        // Cooking/Tools and Woodworking/Tools stay distinguishable.
        const parentId = tagIdFromName(kept[i - 1]!);
        const id = qualifiedTagId(parentId, name);
        if (!qualified.has(id)) {
          qualified.set(id, { id, name: name.trim(), color: colorForTag(name), parent: parentId });
        }
        ids.push(id);
      });

      return [...new Set(ids)];
    },

    allTags() {
      return [...collector.all(), ...qualified.values()];
    },

    ambiguousNames() {
      return ambiguous;
    },
  };
}

/** Convenience for callers that already have entries rather than bare paths. */
export function taggerForEntries(
  entries: readonly RawEntry[],
  rules?: FolderRules,
): FolderTagger {
  return createFolderTagger(entries.map((e) => e.folderPath), rules);
}
