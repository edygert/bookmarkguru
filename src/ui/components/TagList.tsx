import { createEffect, createSignal } from 'solid-js';
import { TagRow } from './TagRow';
import { VirtualList } from './VirtualList';
import { library } from '../state/library';
import type { TagRow as TagRowData } from '../state/library';

/**
 * The tag list.
 *
 * Windowed like the other two, and for a less obvious reason: a real Chrome tree yields
 * hundreds of folder-derived tags, and import deliberately over-produces qualified
 * variants on top of that. This is the list where you go to clean that up, so it is
 * long precisely when it is being used.
 *
 * `Enter` shows the records carrying the tag rather than editing it — before removing a
 * tag you want to see what is on it, and the editor is already open beside the cursor.
 */
export function TagList(props: { items: TagRowData[] }) {
  const [cursor, setCursor] = createSignal(0);

  createEffect(() => {
    const max = Math.max(0, props.items.length - 1);
    if (cursor() > max) setCursor(max);
  });

  const moveTo = (index: number) => {
    setCursor(index);
    const row = props.items[index];
    library.setSelectedTagId(row ? row.tag.id : null);
  };

  return (
    <VirtualList
      items={props.items}
      ariaLabel="Tags"
      cursor={cursor()}
      onCursor={moveTo}
      onActivate={(row) => library.showRecordsForTag(row.tag.id)}
    >
      {(row, index) => (
        <TagRow
          row={row}
          isSelected={library.selectedTagId() === row.tag.id}
          onSelect={() => moveTo(index())}
          onShowRecords={(id) => library.showRecordsForTag(id)}
        />
      )}
    </VirtualList>
  );
}
