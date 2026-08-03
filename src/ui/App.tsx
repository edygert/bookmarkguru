import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import { Sidebar } from './components/Sidebar';
import { BookmarkList } from './components/BookmarkList';
import { TabList } from './components/TabList';
import { TagList } from './components/TagList';
import { DetailPane } from './components/DetailPane';
import { TabDetail } from './components/TabDetail';
import { EmptyState } from './components/EmptyState';
import { library, type ImportOutcome } from './state/library';
import type { SortField } from '~/core/types';

const SORTS: { field: SortField; label: string }[] = [
  { field: 'createdAt', label: 'Date added' },
  { field: 'title', label: 'Title' },
  { field: 'domain', label: 'Domain' },
  { field: 'lastOpenedAt', label: 'Last opened' },
  { field: 'openCount', label: 'Most opened' },
];

/** How long an import summary holds the status bar's one slot. See `report` below. */
const OUTCOME_MS = 10_000;

/**
 * Shared shell for every surface. `compact` collapses to a single column for the
 * side panel — the same components, composed differently, rather than a second app.
 */
export function App(props: { compact?: boolean }) {
  const [outcome, setOutcome] = createSignal<ImportOutcome | null>(null);
  let searchRef: HTMLInputElement | undefined;
  let outcomeTimer: ReturnType<typeof setTimeout> | undefined;

  /** One source of truth, so the sidebar and this pane cannot disagree about it. */
  const importing = () => library.importProgress() !== null;

  const imported = () => {
    const result = outcome();
    return result?.ok ? result.summary : null;
  };
  const importFailed = () => {
    const result = outcome();
    return result && !result.ok ? result.error : null;
  };

  /**
   * Report an import, then take the report back down.
   *
   * The status bar has one slot: while an outcome is showing, the keyboard hints are not.
   * Every path that sets an outcome goes through here, so none can leave the hints
   * permanently replaced.
   *
   * A timer rather than "clear on the next click": the report is about a moment, and the
   * next thing you do might be reading it. Ten seconds is long enough to read three
   * numbers and short enough that the hints come back before you need them.
   */
  const report = (result: ImportOutcome) => {
    clearTimeout(outcomeTimer);
    setOutcome(result);
    outcomeTimer = setTimeout(() => setOutcome(null), OUTCOME_MS);
  };

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
    onCleanup(() => {
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(outcomeTimer);
    });
  });

  const runImport = async () => report(await library.importFromChrome());

  /** Capture whatever the tab list is currently showing, search filter included. */
  const runTabCapture = async () => report(await library.saveTabs(library.visibleTabs()));

  /**
   * How many of the rows on screen are open in a tab right now.
   *
   * Counted over `visible()`, so it is about the list you are looking at rather than the
   * library or the browser — the two numbers beside it are about this list too.
   */
  const openInList = () => library.visible().filter((b) => library.isOpen(b)).length;

  /** The tag the list is scoped to, when the Tags view drilled into one. */
  const scopedTag = () => {
    const id = library.filters.tag;
    return id === undefined ? undefined : library.tagsById().get(id);
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
      /* The Tags view has no detail pane — a tag's name, usage and controls are all on
         its row — so the list takes the full height there. */
      data-detail={props.compact || onTags() ? 'hidden' : 'shown'}
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
                The tag the list is drilled into, and the only way back out of it.

                It renders only while the scope is on, so it is never a control that looks
                live and does nothing — and it must render whenever the scope is on, or the
                list would be hiding most of the library with nothing on screen saying why.
                Stays in `compact`: the side panel has no sidebar, so this is the only way
                to leave a scope there.
              */}
              <Show when={scopedTag()}>
                {(tag) => (
                  <button
                    type="button"
                    class="scope"
                    title={`Showing only links tagged ${tag().name} — click to clear`}
                    onClick={() => library.clearTagScope()}
                  >
                    {tag().name}
                    <span class="scope__clear" aria-hidden="true">×</span>
                  </button>
                )}
              </Show>
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
                body="Import from Chrome, or use the sidebar to import an exported bookmarks file. Folders become tags, so you can find a link by any of them instead of remembering where you filed it. Your Chrome bookmarks are left untouched."
                actionLabel="Import from Chrome"
                onAction={() => void runImport()}
                busy={importing()}
                busyLabel={library.importProgress()?.label}
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
                body="Nothing in this view fits that search. Every term has to match, so try dropping one — or switch view: a link you archived is not in the Library."
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
                {openInList()} open
              </span>
            </Match>
          </Switch>

          {/* The side panel has no sidebar, so this is where its imports report. */}
          <Show when={imported()}>
            {(s) => (
              <span>
                Saved {s().added} · {s().alreadySaved} already saved · {s().skipped} skipped
              </span>
            )}
          </Show>
          <Show when={importFailed()}>{(error) => <span>Import failed. {error()}</span>}</Show>
          <Show when={!props.compact && !outcome()}>
            <span>
              <kbd>/</kbd> search <kbd>j</kbd>/<kbd>k</kbd> move{' '}
              <kbd>↵</kbd> {enterLabel()}
              <Show when={onBookmarks()}>
                <For each={triageKeys()}>
                  {(hint) => <> <kbd>{hint.key}</kbd> {hint.label}</>}
                </For>
              </Show>
              {/* The tag list's own keys. Same rule as the triage hints: they are
                  advertised in the view where they do something. */}
              <Show when={onTags()}>
                <> <kbd>e</kbd> rename <kbd>⌫</kbd> delete</>
              </Show>
            </span>
          </Show>
        </div>
      </main>

      {/*
        One detail pane per view, in the same slot — except the Tags view, which has none:
        a tag's name, usage and controls are all on its row. Nothing may render in the slot
        there, or the grid keeps a `detail` area for it and the list stops at two thirds.
      */}
      <Show when={!props.compact && !onTags()}>
        <Switch fallback={<DetailPane bookmark={library.selected()} />}>
          <Match when={onTabs()}>
            <TabDetail tab={library.selectedTab()} />
          </Match>
        </Switch>
      </Show>
    </div>
  );
}
