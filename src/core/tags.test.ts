import { describe, it, expect } from 'vitest';
import { findNameConflict, generalTagId, retag } from './tags';
import { qualifiedTagId, tagIdFromName } from './ids';
import type { Bookmark, Tag } from './types';

/**
 * The two helpers tag editing rests on. Both exist to survive a rename, which is the
 * event that breaks every name-derived shortcut in this codebase.
 */

const NOW = 1_700_000_000_000;

function tag(id: string, name: string, parent?: string): Tag {
  return { id, name, ...(parent === undefined ? {} : { parent }) };
}

let n = 0;
function bookmark(tags: string[]): Bookmark {
  const i = ++n;
  return {
    id: `b${i}`,
    url: `https://h${i}.example.com/`,
    normalizedUrl: `h${i}.example.com/`,
    domain: `h${i}.example.com`,
    title: 'T',
    tags,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    openCount: 0,
    status: 'active',
    source: {},
  };
}

describe('generalTagId', () => {
  it('resolves a qualified tag to its general form', () => {
    const general = tagIdFromName('SHARED');
    const qualified = qualifiedTagId(tagIdFromName('P1'), 'SHARED');

    expect(generalTagId(tag(qualified, 'SHARED', tagIdFromName('P1')))).toBe(general);
  });

  it('leaves a general tag as itself', () => {
    const general = tagIdFromName('Tools');
    expect(generalTagId(tag(general, 'Tools'))).toBe(general);
  });

  /**
   * The whole reason this derives from the id. Renaming used to move a qualified tag out
   * from under its general one — and because it still had a `parent`, it was excluded
   * from the roots too, so the row vanished rather than moved.
   */
  it('is unchanged by a rename', () => {
    const parent = tagIdFromName('P1');
    const qualified = qualifiedTagId(parent, 'SHARED');

    expect(generalTagId(tag(qualified, 'Something else entirely', parent)))
      .toBe(generalTagId(tag(qualified, 'SHARED', parent)));
  });
});

describe('findNameConflict', () => {
  const p1 = tagIdFromName('P1');
  const p2 = tagIdFromName('P2');

  it('reports another tag that would render identically', () => {
    const tags = [tag(tagIdFromName('Tools'), 'Tools'), tag(tagIdFromName('Rust'), 'Rust')];

    expect(findNameConflict(tags, tagIdFromName('Rust'), 'Tools')?.id)
      .toBe(tagIdFromName('Tools'));
  });

  it('does not report the tag being renamed against itself', () => {
    const tags = [tag(tagIdFromName('Tools'), 'Tools')];
    expect(findNameConflict(tags, tagIdFromName('Tools'), 'Tools')).toBeUndefined();
  });

  /**
   * Import emits the general tag *and* one qualified variant per parent, all carrying the
   * same name. A blanket name check would call every one of them a conflict and refuse
   * renames that are fine. See gotcha #7.
   */
  it('allows a qualified tag to share its general form’s name', () => {
    const tags = [
      tag(tagIdFromName('SHARED'), 'SHARED'),
      tag(qualifiedTagId(p1, 'SHARED'), 'SHARED', p1),
    ];

    expect(findNameConflict(tags, qualifiedTagId(p1, 'SHARED'), 'SHARED')).toBeUndefined();
  });

  it('allows two qualified tags under different parents to share a name', () => {
    const tags = [
      tag(qualifiedTagId(p1, 'SHARED'), 'SHARED', p1),
      tag(qualifiedTagId(p2, 'SHARED'), 'SHARED', p2),
    ];

    expect(findNameConflict(tags, qualifiedTagId(p2, 'SHARED'), 'SHARED')).toBeUndefined();
  });

  it('ignores case and surrounding whitespace', () => {
    const tags = [tag(tagIdFromName('Tools'), 'Tools'), tag(tagIdFromName('Rust'), 'Rust')];
    expect(findNameConflict(tags, tagIdFromName('Rust'), '  tOOLs ')?.id)
      .toBe(tagIdFromName('Tools'));
  });
});

describe('retag', () => {
  it('returns only the records that carried the tag', () => {
    const records = [bookmark(['tag:a']), bookmark(['tag:b']), bookmark(['tag:a', 'tag:c'])];

    const changed = retag(records, 'tag:a', 'tag:z', { now: NOW });

    expect(changed).toHaveLength(2);
    expect(changed.map((b) => b.id)).toEqual([records[0]!.id, records[2]!.id]);
  });

  it('returns nothing when no record carries the tag', () => {
    expect(retag([bookmark(['tag:a'])], 'tag:missing', null, { now: NOW })).toEqual([]);
  });

  it('drops the tag with no replacement on null', () => {
    const changed = retag([bookmark(['tag:a', 'tag:b'])], 'tag:a', null, { now: NOW });
    expect(changed[0]!.tags).toEqual(['tag:b']);
  });

  it('leaves one copy when the record already carries the replacement', () => {
    const changed = retag([bookmark(['tag:a', 'tag:z'])], 'tag:a', 'tag:z', { now: NOW });
    expect(changed[0]!.tags).toEqual(['tag:z']);
  });

  it('does not touch the input records', () => {
    const record = bookmark(['tag:a']);
    retag([record], 'tag:a', null, { now: NOW });
    expect(record.tags).toEqual(['tag:a']);
  });

  it('stamps updatedAt, because dropping a tag changes the record', () => {
    const changed = retag([bookmark(['tag:a'])], 'tag:a', null, { now: NOW });
    expect(changed[0]!.updatedAt).toBe(NOW);
  });
});
