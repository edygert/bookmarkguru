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
