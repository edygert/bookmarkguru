import { createEffect, createSignal } from 'solid-js';
import { BookmarkRow } from './BookmarkRow';
import { VirtualList } from './VirtualList';
import { library } from '../state/library';
import type { Bookmark, BookmarkStatus } from '~/core/types';

/**
 * The library list: rows over the current query result.
 *
 * Windowing lives in `VirtualList` — see the warnings there before touching row height.
 * What stays here is the cursor and what a cursor move *means*, which is the part that
 * differs between this list and the open-tabs one: moving the cursor selects, so the
 * detail pane follows the keyboard.
 *
 * ## Triage keys — and why there is no triage *mode*
 *
 * `a` archives, `r` restores to active, `Delete` destroys. There is no mode to enter or
 * leave: these sit alongside `j`/`k`/`Enter` and are always live. Every view runs the
 * same three transitions, and each key is a no-op when the record is already in the
 * status it would move to — so the Library does not *disable* `r`, it simply holds no
 * archived record for `r` to act on.
 *
 * The record leaving the list is not done here. The sidebar's views are status filters,
 * so changing a record's status drops it out of `visible()` on its own and the next row
 * inherits the cursor's index. All this has to do is keep the selection pointed at
 * whatever now occupies that index.
 *
 * **Deletion is guarded on the record's status, not on which view is showing.** Those
 * are the same thing in a status view (`filters.status` holds one value), but drilling
 * from a tag into its records widens the status filter to all three, so the result set is
 * mixed — and a per-record guard is the one that stays correct there.
 */
export function BookmarkList(props: {
  items: Bookmark[];
  onActivate: (bookmark: Bookmark) => void;
}) {
  const [cursor, setCursor] = createSignal(0);

  // Keep the keyboard cursor in range when filtering shrinks the list.
  createEffect(() => {
    const max = Math.max(0, props.items.length - 1);
    if (cursor() > max) setCursor(max);
  });

  const moveTo = (index: number) => {
    setCursor(index);
    const bookmark = props.items[index];
    if (bookmark) library.setSelectedId(bookmark.id);
  };

  /**
   * Re-aim the cursor after a record has left the list.
   *
   * The index is unchanged, so it already points at the row that moved up into the gap —
   * this exists to bring the *selection* along, which is what makes the detail pane show
   * the next record rather than the one just acted on.
   */
  const landOn = (index: number) => {
    const max = props.items.length - 1;
    if (max < 0) {
      setCursor(0);
      library.setSelectedId(null);
      return;
    }
    moveTo(Math.min(index, max));
  };

  /**
   * ⚠️ Deliberately not awaited. `updateBookmark` patches the store synchronously before
   * its first `await`, so `props.items` has already shrunk by the time `landOn` runs;
   * waiting on the IndexedDB write would leave the cursor a frame behind the list.
   */
  const setStatus = (bookmark: Bookmark, status: BookmarkStatus, index: number) => {
    if (bookmark.status === status) return;
    void library.updateBookmark(bookmark.id, { status });
    landOn(index);
  };

  const onKey = (e: KeyboardEvent, bookmark: Bookmark, index: number) => {
    switch (e.key) {
      case 'a':
        e.preventDefault();
        setStatus(bookmark, 'archived', index);
        break;
      case 'r':
        e.preventDefault();
        setStatus(bookmark, 'active', index);
        break;
      case 'Delete':
      case 'Backspace':
        // Permanent and unrecoverable, so it is reachable only from the Archive — a
        // record has to have been archived first, by a different key, on another screen.
        if (bookmark.status !== 'archived') return;
        e.preventDefault();
        void library.removeBookmark(bookmark.id);
        landOn(index);
        break;
    }
  };

  return (
    <VirtualList
      items={props.items}
      ariaLabel="Bookmarks"
      /* Two-line rows, so this list windows against its own height token rather than the
         one-line `--row-h` the tab and tag lists use. */
      rowHeightVar="--row-h-2"
      cursor={cursor()}
      onCursor={moveTo}
      onActivate={(bookmark) => props.onActivate(bookmark)}
      onKey={onKey}
    >
      {(bookmark, index) => (
        <BookmarkRow
          bookmark={bookmark}
          isOpen={library.isOpen(bookmark)}
          isSelected={library.selectedId() === bookmark.id}
          onSelect={() => moveTo(index())}
          onActivate={props.onActivate}
        />
      )}
    </VirtualList>
  );
}
