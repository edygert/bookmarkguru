import { For, Show } from 'solid-js';
import { library } from '../state/library';
import { generalTagId } from '~/core/tags';
import type { BookmarkStatus, Tag } from '~/core/types';

const STATUS_VIEWS: { status: BookmarkStatus; label: string }[] = [
  { status: 'active', label: 'Library' },
  { status: 'inbox', label: 'Inbox' },
  { status: 'archived', label: 'Archive' },
];

/**
 * Views and tags.
 *
 * **Everything in this pane is a view — one at a time.** That was not always true:
 * "Open now" used to sit among the status views while behaving as a toggle that
 * *composed* with them, styled identically and therefore indistinguishable. Worse, it
 * showed the number of open browser tabs beside a control that filtered bookmarks, so
 * it could read "171" and produce an empty list. The toggle now lives in the toolbar,
 * next to the search box it modifies, and its count is the count it delivers.
 *
 * What replaced it here is a genuine fourth view over the tabs themselves — including
 * the ones that are not bookmarks yet, which no filter over the library could show.
 */
export function Sidebar() {
  const currentStatus = (): BookmarkStatus => library.filters.status?.[0] ?? 'active';
  /**
   * A status view is current only when the filter holds *exactly* that status. Jumping
   * from the tag view widens the filter to all three, and highlighting `Library` there
   * would claim a view that is showing archived records too.
   */
  const onStatusView = (status: BookmarkStatus) =>
    library.view() === 'bookmarks' &&
    library.filters.status?.length === 1 &&
    currentStatus() === status;
  const activeTags = () => library.filters.tags ?? [];
  /** Tags narrow the library only, so none of them read as active from the tab view. */
  const tagIsActive = (id: string) => library.view() === 'bookmarks' && activeTags().includes(id);

  /**
   * A root row's label. Normally just the name — but a qualified tag orphaned by the
   * deletion of its general form is shown as a root, and there it has to name the folder
   * it was kept separate under or it reads as an unexplained duplicate.
   */
  const rootLabel = (tag: Tag): string => {
    const parent = tag.parent === undefined ? undefined : library.tagsById().get(tag.parent);
    return parent ? `${parent.name} · ${tag.name}` : tag.name;
  };

  /** Clicking a tag toggles it, so filters compose without a separate UI. */
  const toggleTag = (id: string) => {
    const current = activeTags();
    // A tag narrows the library, so it has to put you back in the library to mean
    // anything — clicking one from the tab view otherwise looks like a dead control.
    if (library.view() !== 'bookmarks') library.showStatus(currentStatus());
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
   * ⚠️ **The general form is derived from the id, via `generalTagId`, never from the
   * name.** This used to call `tagIdFromName(tag.name)`, which worked only because import
   * generated both names from the same folder. Renaming a qualified tag broke it in the
   * worst available way: the tag still had a `parent`, so it was excluded from the roots,
   * and no root's id matched its new name any more — so the row did not move, it vanished.
   *
   * A qualified tag whose general form is *gone* — deleted, since deleting a general tag
   * does not cascade — is promoted to a root for the same reason. Fail visible.
   */
  const tagTree = () => {
    const counts = library.tagCounts();
    const withCount = library.state.tags
      .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }))
      .filter((entry) => entry.count > 0);

    const byCount = (a: { count: number; tag: Tag }, b: { count: number; tag: Tag }) =>
      b.count - a.count || a.tag.name.localeCompare(b.tag.name);

    const present = new Set(withCount.map((entry) => entry.tag.id));
    const nested = (entry: { tag: Tag }) =>
      entry.tag.parent !== undefined && present.has(generalTagId(entry.tag));

    const children = new Map<string, typeof withCount>();
    for (const entry of withCount) {
      if (!nested(entry)) continue;
      const generalId = generalTagId(entry.tag);
      children.set(generalId, [...(children.get(generalId) ?? []), entry]);
    }

    return withCount
      .filter((entry) => !nested(entry))
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
              aria-current={onStatusView(view.status)}
              onClick={() => library.showStatus(view.status)}
            >
              <span class="nav-item__label">{view.label}</span>
              <span class="nav-item__count">{library.statusCounts()[view.status]}</span>
            </button>
          )}
        </For>

        {/* Tabs, not bookmarks — so the count is a tab count, and clicking shows tabs. */}
        <button
          type="button"
          class="nav-item"
          aria-current={library.view() === 'tabs'}
          onClick={() => library.showTabs()}
        >
          <span class="nav-item__label">Open tabs</span>
          <span class="nav-item__count">{library.openTabs().length}</span>
        </button>

        {/*
          Tags, not bookmarks — so the count is how many tags exist, including the
          zero-record ones the tag list below deliberately hides. This is where a tag
          becomes reachable at all: the list below shows only tags with active records,
          so untagging the last record would otherwise strand a tag in IndexedDB with
          no surface able to reach it.
        */}
        <button
          type="button"
          class="nav-item"
          aria-current={library.view() === 'tags'}
          onClick={() => library.showTags()}
        >
          <span class="nav-item__label">Tags</span>
          <span class="nav-item__count">{library.state.tags.length}</span>
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
                  aria-current={tagIsActive(entry.tag.id)}
                  onClick={() => toggleTag(entry.tag.id)}
                >
                  <span
                    class="tag-dot"
                    style={{ '--tag-color': `var(--tag-${entry.tag.color})` }}
                  />
                  <span class="nav-item__label">{rootLabel(entry.tag)}</span>
                  <span class="nav-item__count">{entry.count}</span>
                </button>

                {/* Children are labelled by the folder that distinguishes them — the
                    name is the same as the parent row's by construction. */}
                <For each={entry.children}>
                  {(child) => (
                    <button
                      type="button"
                      class="nav-item nav-item--child"
                      aria-current={tagIsActive(child.tag.id)}
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
