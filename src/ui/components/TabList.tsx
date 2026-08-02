import { createEffect, createSignal } from 'solid-js';
import { TabRow } from './TabRow';
import { VirtualList } from './VirtualList';
import { library, type OpenTab } from '../state/library';

/**
 * The open-tabs list.
 *
 * Same windowing as the library list, and for the same reason — a browser that has
 * accumulated a few hundred tabs is precisely the browser whose owner needs this view.
 *
 * Activating a row focuses that tab rather than opening anything: every row here is by
 * definition already open, so "open" would only ever mean "go there".
 */
export function TabList(props: { items: OpenTab[] }) {
  const [cursor, setCursor] = createSignal(0);

  createEffect(() => {
    const max = Math.max(0, props.items.length - 1);
    if (cursor() > max) setCursor(max);
  });

  const moveTo = (index: number) => {
    setCursor(index);
    const tab = props.items[index];
    if (tab) library.selectTab(tab);
  };

  return (
    <VirtualList
      items={props.items}
      ariaLabel="Open tabs"
      /* Two-line rows, like the bookmark list. */
      rowHeightVar="--row-h-2"
      cursor={cursor()}
      onCursor={moveTo}
      onActivate={(tab) => void library.focusTab(tab)}
    >
      {(tab, index) => (
        <TabRow
          tab={tab}
          isSelected={library.selectedTabId() === tab.id}
          onSelect={() => moveTo(index())}
          onActivate={(t) => void library.focusTab(t)}
          onSave={(t) => void library.saveTabs([t])}
        />
      )}
    </VirtualList>
  );
}
