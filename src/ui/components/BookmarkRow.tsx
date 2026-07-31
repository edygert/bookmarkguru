import { For, Show } from 'solid-js';
import { Favicon } from './Favicon';
import { library } from '../state/library';
import type { Bookmark } from '~/core/types';

/**
 * One row.
 *
 * Layout note: the **domain leads**, in monospace, ahead of the title. Every other
 * bookmark manager does the reverse. When you are scanning thousands of links you
 * generally recall the domain first ("it was on docs.rs… no, github"), so that is
 * what the eye should land on.
 *
 * A `div role="option"` rather than a `button`, matching `TabRow` and `TagRow`: the
 * domain is a filter control that nests inside the row, and a button inside a button is
 * invalid. `role="option"` is also the right child for the `role="listbox"` that
 * `VirtualList` puts on the container.
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
  const tags = () =>
    props.bookmark.tags
      .map((id) => library.tagsById().get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .slice(0, 3);

  return (
    <div
      class="row"
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
        The domain is also the fastest filter in the app: it is the thing you remember
        first, which is why it leads the row at all. `tabindex="-1"` keeps it out of the
        tab order — keyboard navigation lives on the list, and a focus stop per row would
        put hundreds of them between the list and the detail pane.

        A record whose URL would not parse has `domain: ''` and gets the inert dash it
        always had. There is nothing to filter to, and a control that narrows to nothing
        is worse than no control.
      */}
      <Show
        when={props.bookmark.domain}
        fallback={<span class="row__domain">—</span>}
      >
        <button
          type="button"
          class="row__domain row__domain--filter"
          tabindex="-1"
          title={`Show only ${props.bookmark.domain}`}
          /* Without this the row's own click handler also fires and moves the cursor,
             which is harmless but makes the button feel like it did two things. */
          onClick={(e) => {
            e.stopPropagation();
            library.filterToDomain(props.bookmark.domain);
          }}
        >
          {props.bookmark.domain}
        </button>
      </Show>

      <span class="row__title">{props.bookmark.title}</span>

      <span class="row__tags">
        <For each={tags()}>
          {(tag) => (
            <span class="chip" style={{ '--tag-color': `var(--tag-${tag.color})` }}>
              {tag.name}
            </span>
          )}
        </For>
      </span>

      <Show when={props.bookmark.openCount > 0}>
        <span class="row__meta">{props.bookmark.openCount}×</span>
      </Show>
    </div>
  );
}
