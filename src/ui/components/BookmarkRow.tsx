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
    <button
      type="button"
      class="row"
      data-open={props.isOpen}
      aria-selected={props.isSelected}
      onClick={() => props.onSelect(props.bookmark.id)}
      onDblClick={() => props.onActivate(props.bookmark)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onActivate(props.bookmark);
      }}
      title={props.bookmark.url}
    >
      <span
        class="row__dot"
        aria-label={props.isOpen ? 'Open in a tab' : undefined}
      />
      <Favicon url={props.bookmark.url} />
      <span class="row__domain">{props.bookmark.domain || '—'}</span>
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
    </button>
  );
}
