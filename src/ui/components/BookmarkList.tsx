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
 * container got the right height and rendered no rows. Rows are a fixed height by
 * design (`--row-h`), which is the only thing that makes windowing this easy, so
 * owning these ~45 lines is cheaper than owning that bug.
 */

const OVERSCAN = 8;

let cachedRowH: number | null = null;

/**
 * Row height in pixels, measured from the stylesheet rather than hardcoded.
 *
 * This number and `--row-h` must agree exactly: if they drift, rows overlap or leave
 * gaps and the scrollbar lies about the list length. `--row-h` derives from `--scale`,
 * so a hardcoded copy here breaks the list the moment anyone resizes the UI.
 *
 * ⚠️ **Measured through a probe element, not `getPropertyValue('--row-h')`.** Custom
 * properties substitute lazily, so reading one back returns its *token text* — with a
 * calc-derived value that is the literal string `"calc(34px * 1.75)"`, which
 * `parseFloat` turns into `NaN`. Laying an element out is the only way to make the
 * browser resolve it. This was live for one commit: CSS drew 59.5px rows while the
 * windowing arithmetic used the 34px fallback.
 *
 * Resolved on first use rather than at module load — the dev server injects CSS through
 * JS, so at evaluation time the property may not exist yet. Cached after that: it
 * cannot change without a reload, and re-measuring would force a synchronous layout on
 * every scroll event.
 */
function rowH(): number {
  if (cachedRowH !== null) return cachedRowH;

  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:var(--row-h)';
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();

  // A missing token measures 0, which would divide the windowing maths by zero and
  // render an empty list with no error anywhere. Fall back to the design default.
  cachedRowH = measured > 0 ? measured : 34;
  return cachedRowH;
}

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
    const start = Math.max(0, Math.floor(scrollTop() / rowH()) - OVERSCAN);
    const visible = Math.ceil(viewportH() / rowH()) + OVERSCAN * 2;
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
      const top = next * rowH();
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowH() > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + rowH() - el.clientHeight;
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
      <div style={{ height: `${props.items.length * rowH()}px`, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${range().start * rowH()}px)`,
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
