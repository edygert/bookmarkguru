import { Show } from 'solid-js';
import { Favicon } from './Favicon';
import type { Bookmark } from '~/core/types';

/**
 * One row: the title, then the domain under it.
 *
 * **Tags are not on the row.** The detail pane already lists them, with a remove button
 * on each, and the search box already finds a record by tag name — a third rendering of
 * the same field earned nothing and cost a layout rule at every width (how many chips fit,
 * what a squeezed one looks like, how to say some were dropped).
 *
 * A `div role="option"` rather than a `button`, matching `TabRow` and `TagRow`:
 * `role="option"` is the right child for the `role="listbox"` that `VirtualList` puts on
 * the container, and the tab list's rows nest a Save button, which a button root forbids.
 *
 * ⚠️ **The row must not handle `Enter` itself.** `VirtualList` binds it on the container
 * and the event bubbles, so a row that also handled it would activate twice — which is
 * what a `button` root allowed, since clicking one focuses it. A div with no `tabindex`
 * cannot take focus, so the second path no longer exists. Nothing on screen would show
 * this; it surfaces as `openCount` climbing in pairs.
 *
 * Props are read through `props.x` throughout — destructuring would snapshot the
 * value once and permanently break reactivity, which is the classic Solid bug.
 */
export function BookmarkRow(props: {
  bookmark: Bookmark;
  isOpen: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onActivate: (bookmark: Bookmark) => void;
}) {
  return (
    <div
      class="row row--bookmark"
      role="option"
      data-open={props.isOpen}
      aria-selected={props.isSelected}
      onClick={() => props.onSelect(props.bookmark.id)}
      onDblClick={() => props.onActivate(props.bookmark)}
      title={props.bookmark.url}
    >
      <span
        class="row__dot"
        aria-label={props.isOpen ? 'Open in a tab' : undefined}
      />
      <Favicon url={props.bookmark.url} />

      {/*
        Two lines: the title, then the domain beneath it.

        One line meant a fixed-width column per field, and the domain's was 148px — a
        third of a narrow pane spent on one field, which left titles rendering as `U..`.
        The second line costs height, the cheapest thing a scrolling list has, and gives
        the title the full width.
      */}
      <span class="row__body">
        <span class="row__line">
          <span class="row__title">{props.bookmark.title}</span>
          <Show when={props.bookmark.openCount > 0}>
            <span class="row__meta">{props.bookmark.openCount}×</span>
          </Show>
        </span>

        <span class="row__line row__line--sub">
          {/*
            Text, not a control. This was a button that filtered the list to the domain,
            back when a domain filter existed; typing the host into the search box does
            the same job and reaches subdomains as well.

            A record whose URL would not parse has `domain: ''` and shows the dash.
          */}
          <span class="row__domain">{props.bookmark.domain || '—'}</span>
        </span>
      </span>
    </div>
  );
}
