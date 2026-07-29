import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import { Sidebar } from './components/Sidebar';
import { BookmarkList } from './components/BookmarkList';
import { TabList } from './components/TabList';
import { TagList } from './components/TagList';
import { DetailPane } from './components/DetailPane';
import { TagDetail } from './components/TagDetail';
import { EmptyState } from './components/EmptyState';
import { library } from './state/library';
import type { ImportSummary, SortField } from '~/core/types';

const SORTS: { field: SortField; label: string }[] = [
  { field: 'createdAt', label: 'Date added' },
  { field: 'title', label: 'Title' },
  { field: 'domain', label: 'Domain' },
  { field: 'lastOpenedAt', label: 'Last opened' },
  { field: 'openCount', label: 'Most opened' },
];

/**
 * Shared shell for every surface. `compact` collapses to a single column for the
 * side panel — the same components, composed differently, rather than a second app.
 */
export function App(props: { compact?: boolean }) {
  const [importing, setImporting] = createSignal(false);
  const [summary, setSummary] = createSignal<ImportSummary | null>(null);
  let searchRef: HTMLInputElement | undefined;

  onMount(() => {
    void library.load();
    library.watch();

    // `/` focuses search from anywhere, unless you are already typing somewhere.
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef?.focus();
      }
      if (e.key === 'Escape' && document.activeElement === searchRef) {
        searchRef?.blur();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  const runImport = async () => {
    setImporting(true);
    setSummary(await library.importFromChrome());
    setImporting(false);
  };

  /** Capture whatever the tab list is currently showing, search filter included. */
  const runTabCapture = async () => {
    setImporting(true);
    setSummary(await library.saveTabs(library.visibleTabs()));
    setImporting(false);
  };

  const onTabs = () => library.view() === 'tabs';
  const onTags = () => library.view() === 'tags';
  const onBookmarks = () => library.view() === 'bookmarks';
  const isEmpty = () => !library.state.loading && library.state.bookmarks.length === 0;

  const searchPlaceholder = () => {
    if (onTabs()) return 'Search open tabs…';
    if (onTags()) return 'Search tags…';
    return 'Search title, URL, notes, tags…';
  };

  /** What `Enter` does here. Same rule as the triage hints: label the act, not the key. */
  const enterLabel = () => {
    if (onTabs()) return 'go to tab';
    if (onTags()) return 'show links';
    return 'open';
  };

  /**
   * The triage keys that do something *in the view you are looking at*.
   *
   * `a`/`r`/`Delete` are always bound, but each is a no-op when the record is already in
   * the status it would move to, so a fixed hint line would advertise `⌫ delete` in the
   * Library and deliver nothing. That is gotcha #12 in another costume: a control's label
   * has to describe what that control does here, not what it does somewhere else.
   */
  const triageKeys = (): { key: string; label: string }[] => {
    const statuses = library.filters.status ?? ['active'];

    // A mixed result set — which is what jumping from a tag to its records produces —
    // genuinely has all three keys live, because each is guarded on the *record's*
    // status rather than on the view's. This is the first filter that can do that.
    if (statuses.length !== 1) {
      return [
        { key: 'a', label: 'archive' },
        { key: 'r', label: 'restore' },
        { key: '⌫', label: 'delete' },
      ];
    }

    switch (statuses[0]) {
      case 'inbox':
        return [{ key: 'a', label: 'archive' }, { key: 'r', label: 'keep' }];
      case 'archived':
        return [{ key: 'r', label: 'restore' }, { key: '⌫', label: 'delete' }];
      default:
        return [{ key: 'a', label: 'archive' }];
    }
  };

  return (
    <div
      class="app"
      data-layout={props.compact ? 'compact' : 'full'}
      data-detail={props.compact ? 'hidden' : 'shown'}
    >
      <Show when={!props.compact}>
        <Sidebar />
      </Show>

      <main class="pane">
        <div class="toolbar">
          <input
            ref={searchRef}
            class="search"
            type="search"
            placeholder={searchPlaceholder()}
            value={library.query()}
            onInput={(e) => library.setQuery(e.currentTarget.value)}
          />

          <Switch>
            <Match when={onTabs()}>
              <button
                type="button"
                class="btn btn--primary"
                disabled={importing() || library.unsavedTabCount() === 0}
                onClick={() => void runTabCapture()}
              >
                {library.unsavedTabCount() === 0
                  ? 'All saved'
                  : `Save ${library.unsavedTabCount()} tabs`}
              </button>
            </Match>

            {/* Nothing to sort or narrow here: the search box already filters the list,
                and sorting tags by anything but usage has no use anyone has asked for. */}
            <Match when={onTags()}>{null}</Match>

            <Match when={onBookmarks()}>
              <Show when={!props.compact}>
                <select
                  class="select"
                  value={library.sort().field}
                  onChange={(e) =>
                    library.setSort({ field: e.currentTarget.value as SortField, dir: 'desc' })
                  }
                >
                  {SORTS.map((s) => (
                    <option value={s.field}>{s.label}</option>
                  ))}
                </select>
              </Show>

              {/*
                A toggle, deliberately shaped like one and placed beside the search box
                it narrows — it composes with whichever view the sidebar has selected
                rather than replacing it. Its count is the number of rows it would
                leave, which is the whole point: it used to show the open *tab* count
                next to a control that filters bookmarks.
              */}
              <button
                type="button"
                class="toggle"
                aria-pressed={library.filters.openNow === true}
                title="Show only links that are open in a tab right now"
                onClick={() =>
                  library.setFilters('openNow', library.filters.openNow ? undefined : true)
                }
              >
                Open now
                <span class="toggle__count">{library.openNowCount()}</span>
              </button>
            </Match>
          </Switch>
        </div>

        <Show when={library.state.error}>
          <div class="empty">
            <div class="empty__title">Something went wrong</div>
            <p class="empty__body">{library.state.error}</p>
          </div>
        </Show>

        <Switch>
          <Match when={onTabs()}>
            <Show
              when={library.visibleTabs().length > 0}
              fallback={
                <EmptyState
                  title="No open tabs match"
                  body="Nothing open fits that search. Clear it to see every tab across all your windows."
                />
              }
            >
              <TabList items={library.visibleTabs()} />
            </Show>
          </Match>

          <Match when={onTags()}>
            <Show
              when={library.visibleTags().length > 0}
              fallback={
                <EmptyState
                  title={library.state.tags.length === 0 ? 'No tags yet' : 'No tags match'}
                  body={
                    library.state.tags.length === 0
                      ? 'Import your bookmarks and every folder becomes a tag, or add one to a link from its detail pane.'
                      : 'Nothing here fits that search. Tags are matched by their own name and by the folder that qualifies them.'
                  }
                />
              }
            >
              <TagList items={library.visibleTags()} />
            </Show>
          </Match>

          <Match when={onBookmarks()}>
            <Show when={isEmpty()}>
              <EmptyState
                title="Bring your bookmarks across"
                body="Import from Chrome to get started. Folders become tags, so you can find a link by any of them instead of remembering where you filed it. Your Chrome bookmarks are left untouched."
                actionLabel="Import from Chrome"
                onAction={() => void runImport()}
                busy={importing()}
                secondaryLabel={
                  library.openTabs().length > 0
                    ? `Or capture ${library.openTabs().length} open tabs`
                    : undefined
                }
                onSecondary={() => library.showTabs()}
              />
            </Show>

            <Show when={!isEmpty() && library.visible().length === 0 && !library.state.loading}>
              <EmptyState
                title="No matches"
                body="Nothing here fits that search and the filters you have on. Try a shorter search, or clear a tag in the sidebar."
              />
            </Show>

            <Show when={library.visible().length > 0}>
              <BookmarkList
                items={library.visible()}
                onActivate={(bookmark) => void library.activate(bookmark)}
              />
            </Show>
          </Match>
        </Switch>

        <div class="status-bar">
          <Switch>
            <Match when={onTabs()}>
              <span>
                {library.visibleTabs().length} tabs · {library.unsavedTabCount()} not saved
              </span>
            </Match>
            <Match when={onTags()}>
              <span>
                {library.visibleTags().length} shown · {library.state.tags.length} total ·{' '}
                {library.visibleTags().filter((row) => row.usage.total === 0).length} unused
              </span>
            </Match>
            <Match when={onBookmarks()}>
              <span>
                {library.visible().length} shown · {library.state.bookmarks.length} total ·{' '}
                {library.openNowCount()} open
              </span>
            </Match>
          </Switch>

          <Show when={summary()}>
            {(s) => (
              <span>
                Saved {s().added} · {s().alreadySaved} already saved · {s().skipped} skipped
              </span>
            )}
          </Show>
          <Show when={!props.compact && !summary()}>
            <span>
              <kbd>/</kbd> search <kbd>j</kbd>/<kbd>k</kbd> move{' '}
              <kbd>↵</kbd> {enterLabel()}
              <Show when={onBookmarks()}>
                <For each={triageKeys()}>
                  {(hint) => <> <kbd>{hint.key}</kbd> {hint.label}</>}
                </For>
              </Show>
            </span>
          </Show>
        </div>
      </main>

      <Show when={!props.compact}>
        <Show when={onTags()} fallback={<DetailPane bookmark={library.selected()} />}>
          <TagDetail tag={library.selectedTag()} />
        </Show>
      </Show>
    </div>
  );
}
