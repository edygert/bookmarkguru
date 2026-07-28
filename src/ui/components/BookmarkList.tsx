import { createEffect, createSignal } from 'solid-js';
import { BookmarkRow } from './BookmarkRow';
import { VirtualList } from './VirtualList';
import { library } from '../state/library';
import type { Bookmark } from '~/core/types';

/**
 * The library list: rows over the current query result.
 *
 * Windowing lives in `VirtualList` — see the warnings there before touching row height.
 * What stays here is the cursor and what a cursor move *means*, which is the part that
 * differs between this list and the open-tabs one: moving the cursor selects, so the
 * detail pane follows the keyboard.
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

  return (
    <VirtualList
      items={props.items}
      ariaLabel="Bookmarks"
      cursor={cursor()}
      onCursor={moveTo}
      onActivate={(bookmark) => props.onActivate(bookmark)}
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
