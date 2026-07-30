import { openDB, type IDBPDatabase } from 'idb';
import type { Bookmark, Tag } from '../types';
import type { BookmarkRepository } from './repository';
import { DB_NAME, DB_VERSION, upgrade, type BookmarkGuruDB } from './schema';

/**
 * IndexedDB implementation of BookmarkRepository.
 *
 * Chosen over chrome.storage.local because that API serialises the *entire*
 * collection on every write — at a few thousand bookmarks, toggling one tag would
 * rewrite megabytes. IndexedDB gives per-record writes and real indexes.
 *
 * Safe to instantiate in both page contexts and the service worker: they share the
 * extension origin and therefore the same database. Writes are owned by page
 * contexts (see the architecture notes) because MV3 terminates idle workers.
 */
export class IdbRepository implements BookmarkRepository {
  #db: Promise<IDBPDatabase<BookmarkGuruDB>> | null = null;

  #open(): Promise<IDBPDatabase<BookmarkGuruDB>> {
    // Lazily opened and memoised, so constructing the repo never blocks startup.
    this.#db ??= openDB<BookmarkGuruDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        upgrade(db, oldVersion);
      },
      blocking() {
        // Another context wants to upgrade; release the connection so it can.
        void 0;
      },
    });
    return this.#db;
  }

  // ── bookmarks ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<Bookmark | undefined> {
    return (await this.#open()).get('bookmarks', id);
  }

  async getMany(ids: string[]): Promise<Bookmark[]> {
    if (ids.length === 0) return [];
    const db = await this.#open();
    const tx = db.transaction('bookmarks', 'readonly');
    const found = await Promise.all(ids.map((id) => tx.store.get(id)));
    await tx.done;
    return found.filter((b): b is Bookmark => b !== undefined);
  }

  async getAll(): Promise<Bookmark[]> {
    return (await this.#open()).getAll('bookmarks');
  }

  async findByNormalizedUrl(normalizedUrl: string): Promise<Bookmark[]> {
    return (await this.#open()).getAllFromIndex('bookmarks', 'normalizedUrl', normalizedUrl);
  }

  async put(bookmark: Bookmark): Promise<void> {
    await (await this.#open()).put('bookmarks', bookmark);
  }

  async putMany(bookmarks: Bookmark[]): Promise<void> {
    if (bookmarks.length === 0) return;
    const db = await this.#open();
    const tx = db.transaction('bookmarks', 'readwrite');
    // Queue every put, then await once — awaiting inside the loop would let the
    // transaction auto-close between operations.
    await Promise.all([...bookmarks.map((b) => tx.store.put(b)), tx.done]);
  }

  async remove(id: string): Promise<void> {
    await (await this.#open()).delete('bookmarks', id);
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.#open();
    const tx = db.transaction('bookmarks', 'readwrite');
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  }

  async count(): Promise<number> {
    return (await this.#open()).count('bookmarks');
  }

  // ── tags ─────────────────────────────────────────────────────────────────────

  async getTags(): Promise<Tag[]> {
    return (await this.#open()).getAll('tags');
  }

  async putTag(tag: Tag): Promise<void> {
    await (await this.#open()).put('tags', tag);
  }

  async putTags(tags: Tag[]): Promise<void> {
    if (tags.length === 0) return;
    const db = await this.#open();
    const tx = db.transaction('tags', 'readwrite');
    await Promise.all([...tags.map((t) => tx.store.put(t)), tx.done]);
  }

  async removeTag(id: string): Promise<void> {
    await (await this.#open()).delete('tags', id);
  }

  // ── meta ─────────────────────────────────────────────────────────────────────

  async getMeta<T>(key: string): Promise<T | undefined> {
    const row = await (await this.#open()).get('meta', key);
    return row?.value as T | undefined;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    await (await this.#open()).put('meta', { key, value });
  }

  async clearAll(): Promise<void> {
    const db = await this.#open();
    const stores = ['bookmarks', 'tags', 'meta'] as const;
    const tx = db.transaction(stores, 'readwrite');
    await Promise.all([...stores.map((s) => tx.objectStore(s).clear()), tx.done]);
  }
}

/** Shared instance. One connection per JS context is plenty. */
export const repository: BookmarkRepository = new IdbRepository();
