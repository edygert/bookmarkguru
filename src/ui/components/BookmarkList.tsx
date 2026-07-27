import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { BookmarkRow } from './BookmarkRow';
import { library } from '../state/library';
import type { Bookmark } from '~/core/types';

/**
 * Windowed list.
 *
 * Virtualized from the start rather than in a later pass: importing a real Chrome
 * profile produces thousands of rows immediately, and an unwindowed list of that size
 * makes the very first thing you do feel broken.
 *
 * Hand-rolled rather than using @tanstack/solid-virtual, which was tried first and
 * did not work here: its `totalSize` (a signal) updated correctly while its
 * `virtualItems` (a store, updated through `reconcile`) stayed empty, so the
 * container got the right height and rendered no rows. Rows are a fixed 34px by
 * design (`--row-h`), which is the only thing that makes windowing hard, so owning
 * these ~45 lines is cheaper than owning that bug.
 */

const ROW_H = 34;
const OVERSCAN = 8;

export function BookmarkList(props: {
  items: Bookmark[];
  onActivate: (bookmark: Bookmark) => void;
}) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(600);
  /** Keyboard cursor, distinct from selection so j/k can move without opening. */
  const [cursor, setCursor] = createSignal(0);

  // Track the viewport height so the window sizes itself to the pane, including
  // when the side panel is resized.
  createEffect(() => {
    const el = scrollEl();
    if (!el) return;
    setViewportH(el.clientHeight);
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  const range = createMemo(() => {
    const total = props.items.length;
    const start = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
    const visible = Math.ceil(viewportH() / ROW_H) + OVERSCAN * 2;
    return { start, end: Math.min(total, start + visible) };
  });

  /** Slices share object identity with props.items, so <For> can key by reference. */
  const windowed = createMemo(() => props.items.slice(range().start, range().end));

  // Keep the keyboard cursor in range when filtering shrinks the list.
  createEffect(() => {
    const max = Math.max(0, props.items.length - 1);
    if (cursor() > max) setCursor(max);
  });

  const move = (delta: number) => {
    const next = Math.min(Math.max(cursor() + delta, 0), props.items.length - 1);
    setCursor(next);

    // Scroll only far enough to bring the cursor back into view.
    const el = scrollEl();
    if (el) {
      const top = next * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + ROW_H - el.clientHeight;
      }
    }

    const bookmark = props.items[next];
    if (bookmark) library.setSelectedId(bookmark.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Enter': {
        const bookmark = props.items[cursor()];
        if (bookmark) {
          e.preventDefault();
          props.onActivate(bookmark);
        }
        break;
      }
    }
  };

  return (
    <div
      class="list"
      ref={setScrollEl}
      tabindex="0"
      role="listbox"
      aria-label="Bookmarks"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {/* Spacer gives the scrollbar the full height of the unwindowed list. */}
      <div style={{ height: `${props.items.length * ROW_H}px`, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${range().start * ROW_H}px)`,
          }}
        >
          <For each={windowed()}>
            {(bookmark, i) => (
              <BookmarkRow
                bookmark={bookmark}
                isOpen={library.isOpen(bookmark)}
                isSelected={library.selectedId() === bookmark.id}
                onSelect={(id) => {
                  library.setSelectedId(id);
                  setCursor(range().start + i());
                }}
                onActivate={props.onActivate}
              />
            )}
          </For>
        </div>
      </div>

      <Show when={props.items.length === 0}>
        <div />
      </Show>
    </div>
  );
}
