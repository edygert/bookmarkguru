import { Show } from 'solid-js';
import type { TagRow as TagRowData } from '../state/library';

/**
 * How many records carry this tag, per status.
 *
 * Zero segments are dropped: a tag on four active records reads `4 library`, not
 * `4 library · 0 inbox · 0 archive`. All three are shown when present because deleting the
 * tag touches all three — the same reason `tagUsage` counts them.
 */
function usageLine(row: TagRowData): string {
  const { active, inbox, archived } = row.usage;
  const parts: string[] = [];
  if (active) parts.push(`${active} library`);
  if (inbox) parts.push(`${inbox} inbox`);
  if (archived) parts.push(`${archived} archive`);
  return parts.join(' · ');
}

/**
 * One tag: its name, its usage, and the two things you can do to it.
 *
 * Two lines (`--row-h-2`), like the bookmark and tab rows. There is no tag detail pane —
 * everything a tag has is here, which is why the row carries controls where the other
 * lists carry none.
 *
 * The name is text until it is being edited, and an `<input>` while it is. `TagList` owns
 * which row that is, so only one input exists at a time no matter how many tags there are.
 */
export function TagRow(props: {
  row: TagRowData;
  isSelected: boolean;
  isEditing: boolean;
  error: string | undefined;
  onSelect: () => void;
  onEdit: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  onShowRecords: (id: string) => void;
}) {
  return (
    <div
      class="row row--tag"
      role="option"
      aria-selected={props.isSelected}
      data-unused={props.row.usage.total === 0}
      onClick={() => props.onSelect()}
      onDblClick={() => props.onShowRecords(props.row.tag.id)}
    >
      <span class="row__body">
        <span class="row__line">
          {/* A qualified tag keeps the plain name, so without the folder that
              distinguishes it two rows here would read identically. */}
          <Show when={props.row.parent}>
            {(parent) => <span class="row__prefix">{parent().name}</span>}
          </Show>

          <Show
            when={props.isEditing}
            fallback={
              <span
                class="row__title row__title--editable"
                title="Click to rename"
                /* Only on a row that is already selected: the first click on a row is
                   how you move the cursor there, and a click that both selected and
                   opened an editor would make selecting impossible. */
                onClick={(e) => {
                  if (!props.isSelected) return;
                  e.stopPropagation();
                  props.onEdit();
                }}
              >
                {props.row.tag.name}
              </span>
            }
          >
            <input
              class="row__name-input"
              type="text"
              value={props.row.tag.name}
              aria-invalid={props.error !== undefined}
              ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
              /* ⚠️ The list binds j/k/Enter on its container and events bubble, so
                 without this, typing a `j` moves the cursor out from under the field and
                 Enter drills into the tag's records mid-rename. */
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') props.onCommit(e.currentTarget.value);
                if (e.key === 'Escape') props.onCancel();
              }}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => props.onCommit(e.currentTarget.value)}
            />
          </Show>

          <button
            type="button"
            class="row__action row__action--danger"
            /* Without this the row's own handler also fires and moves the cursor, so
               opening the dialog would look like it did two things. */
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete();
            }}
          >
            Delete
          </button>
        </span>

        <span class="row__line row__line--sub">
          <Show
            when={props.error}
            fallback={
              <span class="row__meta">
                <Show when={props.row.usage.total > 0} fallback="unused">
                  {usageLine(props.row)}
                </Show>
              </span>
            }
          >
            {(message) => <span class="row__error">{message()}</span>}
          </Show>
        </span>
      </span>
    </div>
  );
}
