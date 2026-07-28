/**
 * Id generation.
 *
 * `crypto.randomUUID` is available in extension pages, service workers, and node 19+,
 * so there is no need for a uuid dependency.
 */

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Stable id for a tag derived from its name, so the same tag name arriving from two
 * different import paths collapses to one tag instead of creating a duplicate.
 * Case- and whitespace-insensitive.
 */
export function tagIdFromName(name: string): string {
  return `tag:${name.trim().toLowerCase().replace(/\s+/g, '-')}`;
}

/**
 * Id for a parent-qualified tag: `tag:p1` + `Shared` → `tag:p1/shared`.
 *
 * Used when one folder name appears under two different parents. Merging on name alone
 * would fuse them, and nothing in the record would remember they had been fused — so
 * import qualifies instead. The general tag is emitted as well, which is what keeps the
 * broad grouping working.
 */
export function qualifiedTagId(parentId: string, name: string): string {
  return `${parentId}/${name.trim().toLowerCase().replace(/\s+/g, '-')}`;
}
