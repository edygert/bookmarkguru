import { For, Show, createSignal } from 'solid-js';
import { library } from '../state/library';
import { generalTagId } from '~/core/tags';
import type { BookmarkStatus, Tag } from '~/core/types';

const plural = (n: number) => (n === 1 ? 'link' : 'links');

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
  const [file, setFile] = createSignal<File | null>(null);
  const [confirming, setConfirming] = createSignal(false);
  const [note, setNote] = createSignal<{ text: string; error: boolean } | null>(null);

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

  /**
   * Download the library as JSON.
   *
   * A Blob and an anchor click, deliberately rather than the extension downloads API: that
   * one needs its own manifest permission, and an undeclared namespace is `undefined` at
   * runtime — which kills the service worker silently, with the failure surfacing nowhere.
   * An extension page can write a file with no permission at all.
   */
  const download = async () => {
    setNote(null);
    const url = URL.createObjectURL(
      new Blob([await library.exportBackup()], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `bookmarkguru-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Picking a file resets the primed Replace button.
   *
   * Without this, arming the button and then choosing a different file would leave it
   * pointing at something you have not looked at, one click from replacing the library.
   */
  const choose = (picked: File | undefined) => {
    setFile(picked ?? null);
    setConfirming(false);
    setNote(null);
  };

  /**
   * Two clicks, no dialog — the same shape as deleting a tag, for the same reason. There is
   * no undo, so the count of what is about to be destroyed has to be on the button at the
   * moment of the decision rather than one screen away.
   */
  const restore = async (picked: File) => {
    if (!confirming()) {
      setConfirming(true);
      return;
    }
    const outcome = await library.restoreBackup(await picked.text());
    setConfirming(false);
    setNote(
      outcome.ok
        ? { text: `Restored ${outcome.restored} ${plural(outcome.restored)}.`, error: false }
        : { text: outcome.error ?? 'Restore failed.', error: true },
    );
    if (outcome.ok) setFile(null);
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

      {/*
        Not a view, and deliberately not wearing `nav-item`. Everything in the groups above
        replaces the list or narrows it; these two do neither. They live here rather than in
        the toolbar because the sidebar is absent from the side panel, and replacing the whole
        database should not be a click away in a strip you keep open while browsing.
      */}
      <div class="sidebar__group">
        <div class="sidebar__heading">Backup</div>
        <div class="sidebar__actions">
          <button
            type="button"
            class="btn sidebar__export"
            disabled={library.state.bookmarks.length === 0}
            onClick={() => void download()}
          >
            Export {library.state.bookmarks.length} {plural(library.state.bookmarks.length)}
          </button>

          <input
            id="restore-file"
            class="sidebar__file"
            type="file"
            accept="application/json,.json"
            onChange={(e) => choose(e.currentTarget.files?.[0])}
          />
          <label class="btn sidebar__file-label" for="restore-file">
            <Show when={file()} fallback="Restore from a file…">
              {(picked) => picked().name}
            </Show>
          </label>

          {/* Only appears once a file is chosen — there is nothing to confirm before that. */}
          <Show when={file()}>
            {(picked) => (
              <button
                type="button"
                class="btn sidebar__replace"
                data-confirming={confirming()}
                onClick={() => void restore(picked())}
              >
                <Show when={confirming()} fallback="Replace library">
                  Click again — replaces {library.state.bookmarks.length}{' '}
                  {plural(library.state.bookmarks.length)}
                </Show>
              </button>
            )}
          </Show>

          <Show when={note()}>
            {(shown) => (
              <p class="sidebar__note" data-error={shown().error}>
                {shown().text}
              </p>
            )}
          </Show>
        </div>
      </div>
    </aside>
  );
}
