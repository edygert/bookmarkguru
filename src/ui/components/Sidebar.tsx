import { For, Show } from 'solid-js';
import { library } from '../state/library';
import { tagIdFromName } from '~/core/ids';
import type { BookmarkStatus, Tag } from '~/core/types';

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

  /**
   * Tags as a two-level tree.
   *
   * Import refuses to merge two folders that share a name, so qualified variants exist
   * as separate tags alongside their general form. Rendered flat they are adjacent rows
   * with identical labels, which is useless — nesting each qualified tag under its
   * general one is the whole reason `Tag.parent` exists.
   *
   * A qualified tag keeps the plain name, so its general form is just that name's id.
   */
  const tagTree = () => {
    const counts = library.tagCounts();
    const withCount = library.state.tags
      .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }))
      .filter((entry) => entry.count > 0);

    const byCount = (a: { count: number; tag: Tag }, b: { count: number; tag: Tag }) =>
      b.count - a.count || a.tag.name.localeCompare(b.tag.name);

    const children = new Map<string, typeof withCount>();
    for (const entry of withCount) {
      if (entry.tag.parent === undefined) continue;
      const generalId = tagIdFromName(entry.tag.name);
      children.set(generalId, [...(children.get(generalId) ?? []), entry]);
    }

    return withCount
      .filter((entry) => entry.tag.parent === undefined)
      .sort(byCount)
      .map((entry) => ({
        ...entry,
        children: (children.get(entry.tag.id) ?? []).sort(byCount),
      }));
  };

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

      <Show when={tagTree().length > 0}>
        <div class="sidebar__group">
          <div class="sidebar__heading">Tags</div>
          <For each={tagTree()}>
            {(entry) => (
              <>
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

                {/* Children are labelled by the folder that distinguishes them — the
                    name is the same as the parent row's by construction. */}
                <For each={entry.children}>
                  {(child) => (
                    <button
                      type="button"
                      class="nav-item nav-item--child"
                      aria-current={activeTags().includes(child.tag.id)}
                      onClick={() => toggleTag(child.tag.id)}
                    >
                      <span class="nav-item__label">
                        {library.tagsById().get(child.tag.parent!)?.name ?? child.tag.name}
                      </span>
                      <span class="nav-item__count">{child.count}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </aside>
  );
}
