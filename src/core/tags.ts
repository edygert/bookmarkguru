import { tagIdFromName } from './ids';
import type { Bookmark, Tag } from './types';

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
  add(name: string): string {
    const clean = name.trim();
    if (!clean) return '';
    const id = tagIdFromName(clean);
    if (!this.#byId.has(id)) this.#byId.set(id, { id, name: clean });
    return id;
  }

  all(): Tag[] {
    return [...this.#byId.values()];
  }

  get size(): number {
    return this.#byId.size;
  }
}

/**
 * The id of a qualified tag's general form: `tag:p1/shared` → `tag:shared`.
 * A general tag is its own general form, so this is safe to call on any tag.
 *
 * ⚠️ **Derived from the id, never from the name.** The sidebar used to find the general
 * tag with `tagIdFromName(tag.name)`, which held only because import generates both names
 * from the same folder. Rename breaks it silently and in the worst way: a renamed
 * qualified tag has a `parent`, so it is excluded from the roots, and no root's id matches
 * its new name any more — the row does not move, it disappears. Ids never change, so
 * deriving from the id survives any rename.
 */
export function generalTagId(tag: Tag): string {
  const slash = tag.id.lastIndexOf('/');
  return slash === -1 ? tag.id : `tag:${tag.id.slice(slash + 1)}`;
}

/**
 * The tag a rename would make indistinguishable from, if there is one.
 *
 * ⚠️ **Scoped to tags with the same `parent`, not to the whole set.** A blanket
 * name check would refuse most legitimate renames: parent-qualified tags *deliberately*
 * share a name with their general form and with each other — that is gotcha #7, and it is
 * why the `name` index is not unique. Those are still told apart on screen, because a
 * qualified tag renders behind its parent's name (`P1 · SHARED`).
 *
 * What is genuinely unusable is two tags that render identically: same name, same parent.
 * Nothing in the UI could tell you which one a record carries.
 */
export function findNameConflict(
  tags: readonly Tag[],
  id: string,
  name: string,
): Tag | undefined {
  const clean = name.trim().toLowerCase();
  if (!clean) return undefined;

  const self = tags.find((t) => t.id === id);
  return tags.find(
    (t) => t.id !== id && t.parent === self?.parent && t.name.trim().toLowerCase() === clean,
  );
}

export interface RetagOptions {
  now?: number;
}

/**
 * Replace or drop a tag id across a set of records, returning **only the ones that
 * changed** — so the caller writes a handful of records rather than the whole library.
 *
 * `to: null` removes the tag without a replacement, which is what deleting a tag does.
 * A record that already carries `to` ends up with one copy, not two.
 *
 * ⚠️ **Hand this unwrapped records.** It spreads each input one level, so a Solid store
 * proxy in gives an object whose nested `tags` and `source` are still proxies out, and
 * IndexedDB throws `"[object Array] could not be cloned"` on the write — visibly *after*
 * the UI has already shown the new value. Core cannot call `unwrap` itself (it must not
 * import Solid), so this is the caller's job. See the gotchas in PROGRESS.md.
 */
export function retag(
  bookmarks: readonly Bookmark[],
  from: string,
  to: string | null,
  options: RetagOptions = {},
): Bookmark[] {
  const { now = Date.now() } = options;
  const changed: Bookmark[] = [];

  for (const bookmark of bookmarks) {
    if (!bookmark.tags.includes(from)) continue;

    const kept = bookmark.tags.filter((id) => id !== from);
    const tags = to === null || kept.includes(to) ? kept : [...kept, to];
    changed.push({ ...bookmark, tags, updatedAt: now });
  }

  return changed;
}
