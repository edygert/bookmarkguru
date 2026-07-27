import type { DBSchema, IDBPDatabase } from 'idb';
import type { Bookmark, Collection, SavedSearch, Tag } from '../types';

export const DB_NAME = 'bookmarkguru';
export const DB_VERSION = 1;

/** Bumped independently of DB_VERSION; written into JSON backups for restore validation. */
export const SCHEMA_VERSION = 1;

export interface BookmarkGuruDB extends DBSchema {
  bookmarks: {
    key: string;
    value: Bookmark;
    indexes: {
      /**
       * Deliberately NOT unique. Duplicates are a review workflow, not an error —
       * a unique index would make bulk import fail on conflict instead of
       * collecting candidates for the user to merge.
       */
      normalizedUrl: string;
      domain: string;
      createdAt: number;
      updatedAt: number;
      /** Records with a null lastOpenedAt are simply absent from this index. */
      lastOpenedAt: number;
      status: string;
      /** multiEntry: one index entry per tag id, so tag filtering hits an index. */
      tags: string;
    };
  };
  tags: {
    key: string;
    value: Tag;
    indexes: { name: string };
  };
  collections: {
    key: string;
    value: Collection;
  };
  savedSearches: {
    key: string;
    value: SavedSearch;
  };
  /** Settings, serialized search index, first-run marker. */
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export function upgrade(db: IDBPDatabase<BookmarkGuruDB>, oldVersion: number): void {
  // Written as sequential non-exclusive steps so future versions just append a block.
  if (oldVersion < 1) {
    const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
    bookmarks.createIndex('normalizedUrl', 'normalizedUrl', { unique: false });
    bookmarks.createIndex('domain', 'domain');
    bookmarks.createIndex('createdAt', 'createdAt');
    bookmarks.createIndex('updatedAt', 'updatedAt');
    bookmarks.createIndex('lastOpenedAt', 'lastOpenedAt');
    bookmarks.createIndex('status', 'status');
    bookmarks.createIndex('tags', 'tags', { multiEntry: true });

    const tags = db.createObjectStore('tags', { keyPath: 'id' });
    tags.createIndex('name', 'name', { unique: true });

    db.createObjectStore('collections', { keyPath: 'id' });
    db.createObjectStore('savedSearches', { keyPath: 'id' });
    db.createObjectStore('meta', { keyPath: 'key' });
  }
}

/** Keys used in the `meta` store. Centralised so they cannot drift apart. */
export const META = {
  schemaVersion: 'schemaVersion',
  firstRunComplete: 'firstRunComplete',
  searchIndex: 'searchIndex',
  settings: 'settings',
} as const;
