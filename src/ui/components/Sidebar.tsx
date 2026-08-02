import { For, Show, createSignal } from 'solid-js';
import { library, type ImportOutcome, type ImportProgress } from '../state/library';
import type { BookmarkStatus } from '~/core/types';

const plural = (n: number) => (n === 1 ? 'link' : 'links');

/** `Saving links… 3,140 / 5,002`, or the label alone while there is nothing to count. */
const progressText = (progress: ImportProgress) =>
  progress.total > 0
    ? `${progress.label} ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
    : progress.label;

const STATUS_VIEWS: { status: BookmarkStatus; label: string }[] = [
  { status: 'active', label: 'Library' },
  { status: 'inbox', label: 'Inbox' },
  { status: 'archived', label: 'Archive' },
];

/**
 * Navigation. Five views, and two groups of actions.
 *
 * **Nothing in this pane narrows a list any more.** A tag list, a domain list and an
 * `Open now` toggle all lived here or in the toolbar, and all three were second paths to
 * something the search box already did: `runQuery`'s text match reads `url`, so typing a
 * bare host narrows to that host, and it reads tag *names*, so typing a tag name narrows
 * to that tag. Two controls answering one question drift apart and have to be kept in
 * step for nothing.
 *
 * The rule this leaves behind, and the reason to keep this comment: **a control in here
 * replaces the list; the search box narrows it.** Anything that narrows belongs in the
 * toolbar beside the box it composes with — that is where `Open now` was moved to before
 * it was deleted outright, after a spell in this pane where it was styled as a view,
 * could appear selected alongside one, and showed the number of open browser *tabs*
 * beside a control that filtered bookmarks (171, delivering an empty list).
 *
 * `Open tabs` and `Tags` are genuine views, not filters in disguise: each lists things
 * that are *not records* — a tab the database has never seen, a tag on zero records —
 * and no search over the library could ever reach them.
 */
export function Sidebar() {
  const [file, setFile] = createSignal<File | null>(null);
  const [confirming, setConfirming] = createSignal(false);
  const [note, setNote] = createSignal<{ text: string; error: boolean } | null>(null);
  const [importFiles, setImportFiles] = createSignal<File[]>([]);
  const [importNote, setImportNote] = createSignal<{ text: string; error: boolean } | null>(null);

  const importing = () => library.importProgress() !== null;

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

  /**
   * Both sources report the same way, because they are the same import.
   *
   * A summary of all zeros is a real result — nothing in the file, or nothing new in it —
   * and it used to be indistinguishable from a crash, which returned all zeros too.
   * `added + alreadySaved + skipped` is the number of entries the parser produced.
   */
  const report = (outcome: ImportOutcome, fromFile: boolean) => {
    if (!outcome.ok) {
      setImportNote({ text: outcome.error, error: true });
      return;
    }

    const { added, alreadySaved, skipped } = outcome.summary;
    if (added + alreadySaved + skipped === 0) {
      setImportNote({
        text: fromFile ? 'No bookmarks in that file. Is it a browser export?' : 'No bookmarks found.',
        error: true,
      });
    } else if (added === 0) {
      setImportNote({
        text: `Nothing new — all ${alreadySaved} ${plural(alreadySaved)} were already saved.`,
        error: false,
      });
    } else {
      setImportNote({
        text: `Added ${added} · ${alreadySaved} already saved · ${skipped} skipped`,
        error: false,
      });
    }
  };

  const runChromeImport = async () => {
    setImportNote(null);
    report(await library.importFromChrome(), false);
  };

  const runFileImport = async () => {
    const files = importFiles();
    if (files.length === 0) return;
    setImportNote(null);
    report(await library.importFromFiles(files), true);
    setImportFiles([]);
  };

  /**
   * Clearing the input's own value is what lets the *same* file be picked twice. The
   * File objects are already captured, and re-importing one is a legitimate thing to do:
   * it adds whatever is new and ignores the rest.
   */
  const chooseImport = (input: HTMLInputElement) => {
    setImportFiles([...(input.files ?? [])]);
    setImportNote(null);
    input.value = '';
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
          Tags, not bookmarks — so the count is how many tags exist, zero-record ones
          included. This is the only surface that can reach those: no search over records
          finds a tag no record carries, so without this view untagging the last record
          would strand a tag in IndexedDB with nothing able to rename or delete it.
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

      {/*
        One import, two sources. The live tree is what Chrome has now; a file is a snapshot,
        which is the only difference anyone sees — everything downstream of the two parsers
        is shared, including the dedupe that makes a re-import add only what is new.

        Not a view, and deliberately not wearing `nav-item`.
      */}
      <div class="sidebar__group sidebar__group--import">
        <div class="sidebar__heading">Import</div>
        <div class="sidebar__actions">
          <button
            type="button"
            class="btn sidebar__chrome"
            disabled={importing()}
            onClick={() => void runChromeImport()}
          >
            Import from Chrome
          </button>

          <input
            id="import-file"
            class="sidebar__file"
            type="file"
            accept=".html,text/html"
            multiple
            onChange={(e) => chooseImport(e.currentTarget)}
          />
          <label class="btn sidebar__file-label" for="import-file">
            <Show when={importFiles().length > 0} fallback="Import a file…">
              {importFiles().length === 1
                ? importFiles()[0]!.name
                : `${importFiles().length} files`}
            </Show>
          </label>

          {/* One click, not two: this only adds records, so there is nothing to confirm. */}
          <Show when={importFiles().length > 0}>
            <button
              type="button"
              class="btn btn--primary sidebar__import"
              disabled={importing()}
              onClick={() => void runFileImport()}
            >
              Import
            </button>
          </Show>

          <Show when={library.importProgress()}>
            {(progress) => (
              <>
                {/* Omitted while reading and parsing, which have no countable steps. */}
                <Show when={progress().total > 0}>
                  <progress
                    class="sidebar__progress"
                    value={progress().done}
                    max={progress().total}
                  />
                </Show>
                <p class="sidebar__note">{progressText(progress())}</p>
              </>
            )}
          </Show>

          <Show when={importNote()}>
            {(shown) => (
              <p class="sidebar__note" data-error={shown().error}>
                {shown().text}
              </p>
            )}
          </Show>
        </div>
      </div>

      {/*
        Not a view either. These live here rather than in the toolbar because the sidebar is
        absent from the side panel, and replacing the whole database should not be a click
        away in a strip you keep open while browsing.
      */}
      <div class="sidebar__group sidebar__group--backup">
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
