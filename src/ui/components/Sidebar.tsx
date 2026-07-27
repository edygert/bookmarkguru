import { For, Show } from 'solid-js';
import { library } from '../state/library';
import type { BookmarkStatus } from '~/core/types';

const STATUS_VIEWS: { status: BookmarkStatus; label: string }[] = [
  { status: 'active', label: 'Library' },
  { status: 'inbox', label: 'Inbox' },
  { status: 'archived', label: 'Archive' },
];

export function Sidebar() {
  const currentStatus = (): BookmarkStatus => library.filters.status?.[0] ?? 'active';
  const activeTags = () => library.filters.tags ?? [];

  const selectStatus = (status: BookmarkStatus) => {
    library.setFilters({ status: [status], tags: [] });
  };

  /** Clicking a tag toggles it, so filters compose without a separate UI. */
  const toggleTag = (id: string) => {
    const current = activeTags();
    library.setFilters(
      'tags',
      current.includes(id) ? current.filter((t) => t !== id) : [...current, id],
    );
  };

  const sortedTags = () =>
    [...library.state.tags]
      .map((tag) => ({ tag, count: library.tagCounts().get(tag.id) ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name));

  return (
    <aside class="pane sidebar">
      <div class="sidebar__group">
        <div class="sidebar__heading">Views</div>
        <For each={STATUS_VIEWS}>
          {(view) => (
            <button
              type="button"
              class="nav-item"
              aria-current={currentStatus() === view.status}
              onClick={() => selectStatus(view.status)}
            >
              <span class="nav-item__label">{view.label}</span>
              <span class="nav-item__count">{library.statusCounts()[view.status]}</span>
            </button>
          )}
        </For>

        <button
          type="button"
          class="nav-item"
          aria-current={library.filters.openNow === true}
          onClick={() => library.setFilters('openNow', library.filters.openNow ? undefined : true)}
        >
          <span class="nav-item__label">Open now</span>
          <span class="nav-item__count">{library.openUrls().size}</span>
        </button>
      </div>

      <Show when={sortedTags().length > 0}>
        <div class="sidebar__group">
          <div class="sidebar__heading">Tags</div>
          <For each={sortedTags()}>
            {(entry) => (
              <button
                type="button"
                class="nav-item"
                aria-current={activeTags().includes(entry.tag.id)}
                onClick={() => toggleTag(entry.tag.id)}
              >
                <span
                  class="tag-dot"
                  style={{ '--tag-color': `var(--tag-${entry.tag.color})` }}
                />
                <span class="nav-item__label">{entry.tag.name}</span>
                <span class="nav-item__count">{entry.count}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
}
