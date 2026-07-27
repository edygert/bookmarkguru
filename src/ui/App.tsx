import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Sidebar } from './components/Sidebar';
import { BookmarkList } from './components/BookmarkList';
import { DetailPane } from './components/DetailPane';
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

  const isEmpty = () => !library.state.loading && library.state.bookmarks.length === 0;

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
            placeholder="Search title, URL, notes, tags…"
            value={library.query()}
            onInput={(e) => library.setQuery(e.currentTarget.value)}
          />
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
        </div>

        <Show when={library.state.error}>
          <div class="empty">
            <div class="empty__title">Something went wrong</div>
            <p class="empty__body">{library.state.error}</p>
          </div>
        </Show>

        <Show when={isEmpty()}>
          <EmptyState
            title="Bring your bookmarks across"
            body="Import from Chrome to get started. Folders become tags, so you can find a link by any of them instead of remembering where you filed it. Your Chrome bookmarks are left untouched."
            actionLabel="Import from Chrome"
            onAction={() => void runImport()}
            busy={importing()}
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

        <div class="status-bar">
          <span>
            {library.visible().length} shown · {library.state.bookmarks.length} total ·{' '}
            {library.openUrls().size} open
          </span>
          <Show when={summary()}>
            {(s) => (
              <span>
                Imported {s().added} · {s().alreadySaved} already saved · {s().skipped} skipped
              </span>
            )}
          </Show>
          <Show when={!props.compact && !summary()}>
            <span>
              <kbd>/</kbd> search <kbd>j</kbd>/<kbd>k</kbd> move <kbd>↵</kbd> open
            </span>
          </Show>
        </div>
      </main>

      <Show when={!props.compact}>
        <DetailPane bookmark={library.selected()} />
      </Show>
    </div>
  );
}
