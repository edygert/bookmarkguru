import { Show, createEffect, createSignal } from 'solid-js';
import { TagRow } from './TagRow';
import { VirtualList } from './VirtualList';
import { library } from '../state/library';
import type { TagRow as TagRowData } from '../state/library';

/**
 * The tag list, and the whole of tag management.
 *
 * Windowed like the other two, and for a less obvious reason: a real Chrome tree yields
 * hundreds of folder-derived tags, and import deliberately over-produces qualified
 * variants on top of that. This is the list where you go to clean that up, so it is long
 * precisely when it is being used.
 *
 * Rename and delete live here rather than in a detail pane. This component owns which row
 * is being edited and which is pending deletion — a row cannot own either, because a
 * windowed row unmounts the moment it scrolls out of range, which would close an open
 * editor and unmount an open dialog.
 *
 * `Enter` shows the records carrying the tag; `e` renames; `Delete` asks.
 */
export function TagList(props: { items: TagRowData[] }) {
  const [cursor, setCursor] = createSignal(0);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<{ id: string; message: string } | null>(null);
  const [pending, setPending] = createSignal<TagRowData | null>(null);

  let dialog: HTMLDialogElement | undefined;

  createEffect(() => {
    const max = Math.max(0, props.items.length - 1);
    if (cursor() > max) setCursor(max);
  });

  const moveTo = (index: number) => {
    setCursor(index);
    // Moving the cursor ends any edit: one input in the DOM at a time, and an editor left
    // open on a row you have navigated away from is a write waiting to happen by accident.
    setEditingId(null);
    setError(null);
    const row = props.items[index];
    library.setSelectedTagId(row ? row.tag.id : null);
  };

  /** Hand the keyboard back, or `j`/`k`/`Enter` reach nothing after the dialog closes. */
  const refocusList = () => {
    (document.querySelector('.list') as HTMLElement | null)?.focus();
  };

  const commit = async (row: TagRowData, name: string) => {
    setEditingId(null);
    const result = await library.renameTag(row.tag.id, name);
    setError(
      result.conflict === undefined
        ? null
        : { id: row.tag.id, message: `Already a tag called “${result.conflict}”.` },
    );
    refocusList();
  };

  const askDelete = (row: TagRowData) => {
    setEditingId(null);
    setPending(row);
    // `showModal` rather than `open`: it takes focus, traps it, closes on Escape and
    // dims the page behind, none of which a plain overlay gets for free.
    queueMicrotask(() => dialog?.showModal());
  };

  const closeDialog = () => {
    dialog?.close();
    setPending(null);
    refocusList();
  };

  const confirmDelete = async () => {
    const row = pending();
    if (!row) return;
    closeDialog();
    await library.deleteTag(row.tag.id);
  };

  const onKey = (e: KeyboardEvent, row: TagRowData) => {
    switch (e.key) {
      case 'e':
        e.preventDefault();
        setError(null);
        setEditingId(row.tag.id);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        askDelete(row);
        break;
    }
  };

  return (
    <>
      <VirtualList
        items={props.items}
        ariaLabel="Tags"
        /* Two-line rows, like the bookmark and tab lists. */
        rowHeightVar="--row-h-2"
        cursor={cursor()}
        onCursor={moveTo}
        onActivate={(row) => library.showRecordsForTag(row.tag.id)}
        onKey={onKey}
      >
        {(row, index) => (
          <TagRow
            row={row}
            isSelected={library.selectedTagId() === row.tag.id}
            isEditing={editingId() === row.tag.id}
            error={error()?.id === row.tag.id ? error()?.message : undefined}
            onSelect={() => moveTo(index())}
            onEdit={() => {
              setError(null);
              setEditingId(row.tag.id);
            }}
            onCommit={(name) => void commit(row, name)}
            onCancel={() => {
              setEditingId(null);
              refocusList();
            }}
            onDelete={() => askDelete(row)}
            onShowRecords={(id) => library.showRecordsForTag(id)}
          />
        )}
      </VirtualList>

      {/*
        Deleting strips the tag from every record that carries it and there is no undo
        anywhere in this app, so the count it will touch has to be in front of you at the
        moment you decide — not one screen away, and not inferred from a row.

        `Cancel` is focused on open, so a stray Enter closes rather than deletes.
      */}
      <dialog class="dialog" ref={dialog} onClose={() => setPending(null)}>
        <Show when={pending()}>
          {(row) => (
            <>
              <h2 class="dialog__title">Delete tag?</h2>
              <p class="dialog__body">
                “{row().tag.name}” is on {row().usage.total}{' '}
                {row().usage.total === 1 ? 'link' : 'links'}. Deleting removes the tag from
                all of them. No link is deleted. This cannot be undone.
              </p>
              <div class="dialog__actions">
                <button type="button" class="btn" autofocus onClick={() => closeDialog()}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn--danger"
                  onClick={() => void confirmDelete()}
                >
                  Delete tag
                </button>
              </div>
            </>
          )}
        </Show>
      </dialog>
    </>
  );
}
