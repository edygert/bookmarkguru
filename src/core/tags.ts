import { tagIdFromName } from './ids';
import type { Tag } from './types';

/**
 * Tag colours are token *names*, not hex values, so the stylesheet owns the actual
 * colours and can render them differently in light and dark themes.
 */
export const TAG_COLORS = [
  'slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'cyan',
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/** Chrome's tab-group palette → ours, so imported groups keep their colour. */
const CHROME_GROUP_COLORS: Record<string, TagColor> = {
  grey: 'slate',
  blue: 'blue',
  red: 'red',
  yellow: 'amber',
  green: 'green',
  pink: 'pink',
  purple: 'purple',
  cyan: 'cyan',
  orange: 'orange',
};

export function mapChromeGroupColor(color: string | undefined): TagColor {
  return (color && CHROME_GROUP_COLORS[color]) || 'slate';
}

/**
 * Deterministic colour for a tag with no colour of its own, so imported folders get
 * a varied but *stable* palette — re-importing must not reshuffle every colour.
 */
export function colorForTag(name: string): TagColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]!;
}

/**
 * Accumulates tags by id while importing.
 *
 * Ids derive from the normalised name (see `tagIdFromName`), so the same folder name
 * appearing in two branches — or the same name arriving from both an HTML import and
 * a tab import — collapses to one tag rather than creating duplicates.
 */
export class TagCollector {
  readonly #byId = new Map<string, Tag>();

  /** Returns the tag id, creating the tag on first sight. */
  add(name: string, color?: TagColor): string {
    const clean = name.trim();
    if (!clean) return '';
    const id = tagIdFromName(clean);
    const existing = this.#byId.get(id);
    if (existing) {
      // An explicit colour (e.g. from a Chrome tab group) upgrades a derived one.
      if (color && existing.color !== color) existing.color = color;
      return id;
    }
    this.#byId.set(id, { id, name: clean, color: color ?? colorForTag(clean) });
    return id;
  }

  all(): Tag[] {
    return [...this.#byId.values()];
  }

  get size(): number {
    return this.#byId.size;
  }
}
