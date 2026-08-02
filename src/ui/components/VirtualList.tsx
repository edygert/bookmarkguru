import { For, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from 'solid-js';

/**
 * Windowed list with a keyboard cursor. Shared by the bookmark list and the open-tabs
 * list, which differ only in what a row looks like.
 *
 * Virtualized from the start rather than in a later pass: importing a real Chrome
 * profile produces thousands of rows immediately, and a browser with a hundred-plus
 * tabs open is the normal case for the tab view — an unwindowed list of either size
 * makes the very first thing you do feel broken.
 *
 * Hand-rolled rather than using @tanstack/solid-virtual, which was tried first and
 * did not work here: its `totalSize` (a signal) updated correctly while its
 * `virtualItems` (a store, updated through `reconcile`) stayed empty, so the
 * container got the right height and rendered no rows. Rows are a fixed height by
 * design (`--row-h`), which is the only thing that makes windowing this easy, so
 * owning these ~50 lines is cheaper than owning that bug.
 *
 * The cursor is **controlled by the parent**. It has to be: clicking a row moves the
 * cursor there, and the click handler lives in the row, which the parent renders.
 */

const OVERSCAN = 8;

const cachedRowH = new Map<string, number>();

/**
 * Row height in pixels, measured from the stylesheet rather than hardcoded.
 *
 * This number and the token must agree exactly: if they drift, rows overlap or leave
 * gaps and the scrollbar lies about the list length. The tokens derive from `--scale`,
 * so a hardcoded copy here breaks the list the moment anyone resizes the UI.
 *
 * Keyed by token, because the lists are not all the same height: a bookmark row is two
 * lines and a tab or tag row is one. A single cached number would window one of them
 * against the other's height.
 *
 * ⚠️ **Measured through a probe element, not `getPropertyValue()`.** Custom properties
 * substitute lazily, so reading one back returns its *token text* — with a calc-derived
 * value that is the literal string `"calc(34px * 1.75)"`, which `parseFloat` turns into
 * `NaN`. Laying an element out is the only way to make the browser resolve it. This was
 * live for one commit: CSS drew 59.5px rows while the windowing arithmetic used the 34px
 * fallback.
 *
 * Resolved on first use rather than at module load — the dev server injects CSS through
 * JS, so at evaluation time the property may not exist yet. Cached after that: it
 * cannot change without a reload, and re-measuring would force a synchronous layout on
 * every scroll event.
 */
function rowH(token: string): number {
  const hit = cachedRowH.get(token);
  if (hit !== undefined) return hit;

  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;height:var(${token})`;
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();

  // A missing token measures 0, which would divide the windowing maths by zero and
  // render an empty list with no error anywhere. Fall back to the design default.
  const resolved = measured > 0 ? measured : 34;
  cachedRowH.set(token, resolved);
  return resolved;
}

export function VirtualList<T>(props: {
  items: readonly T[];
  ariaLabel: string;
  /**
   * Custom property holding this list's row height. Defaults to the one-line `--row-h`;
   * the bookmark list is two lines and passes its own. Whatever is passed has to match
   * what CSS actually draws for that list's rows — see `rowH` above.
   */
  rowHeightVar?: string;
  /** Index of the keyboard cursor. Owned by the parent; see the note above. */
  cursor: number;
  onCursor: (index: number) => void;
  onActivate?: (item: T, index: number) => void;
  /**
   * Keys this component does not handle itself, with the row under the cursor.
   *
   * An escape hatch rather than more cases in the switch below: the bookmark list binds
   * status keys here, and this component is shared with the open-tabs list, where a tab
   * has no status to change. Teaching the shared component about bookmarks to keep the
   * keys in one place would put the knowledge in the wrong file.
   */
  onKey?: (event: KeyboardEvent, item: T, index: number) => void;
  /** Renders one row. The index accessor is absolute, not relative to the window. */
  children: (item: T, index: Accessor<number>) => JSX.Element;
}) {
  const rowHeight = () => rowH(props.rowHeightVar ?? '--row-h');

  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(600);

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
    const start = Math.max(0, Math.floor(scrollTop() / rowHeight()) - OVERSCAN);
    const visible = Math.ceil(viewportH() / rowHeight()) + OVERSCAN * 2;
    return { start, end: Math.min(total, start + visible) };
  });

  /** Slices share object identity with props.items, so <For> can key by reference. */
  const windowed = createMemo(() => props.items.slice(range().start, range().end));

  /**
   * Scroll just far enough to bring the cursor back into view.
   *
   * Runs on every cursor change, including one caused by a click. That is harmless —
   * a clicked row is on screen already, so the arithmetic below moves nothing.
   */
  createEffect(() => {
    const index = props.cursor;
    const el = scrollEl();
    if (!el || index < 0) return;

    const top = index * rowHeight();
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight() > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + rowHeight() - el.clientHeight;
    }
  });

  const move = (delta: number) => {
    if (props.items.length === 0) return;
    props.onCursor(Math.min(Math.max(props.cursor + delta, 0), props.items.length - 1));
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
        const item = props.items[props.cursor];
        if (item !== undefined) {
          e.preventDefault();
          props.onActivate?.(item, props.cursor);
        }
        break;
      }
      default: {
        const item = props.items[props.cursor];
        if (item !== undefined) props.onKey?.(e, item, props.cursor);
      }
    }
  };

  return (
    <div
      class="list"
      ref={setScrollEl}
      tabindex="0"
      role="listbox"
      aria-label={props.ariaLabel}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      /*
       * Clicking a row hands the keyboard to the list.
       *
       * Rows are `div role="option"` and so cannot hold focus — which is correct for a
       * listbox, and required because controls nest inside them. But it means a click
       * would otherwise leave focus on `<body>`, where `j`/`k`/`Enter` reach nothing:
       * you would pick a row with the mouse and find the keys dead. Focusing the
       * container here is what keeps the two input methods on speaking terms.
       *
       * A nested control that calls `stopPropagation` — the domain filter, the tab
       * Save button — never gets here, so it does not steal the cursor as a side effect.
       */
      onClick={(e) => e.currentTarget.focus()}
      onKeyDown={onKeyDown}
    >
      {/* Spacer gives the scrollbar the full height of the unwindowed list. */}
      <div style={{ height: `${props.items.length * rowHeight()}px`, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${range().start * rowHeight()}px)`,
          }}
        >
          <For each={windowed()}>
            {(item, i) => props.children(item, () => range().start + i())}
          </For>
        </div>
      </div>
    </div>
  );
}
