import { For, Show, createEffect, createSignal } from 'solid-js';
import { library } from '../state/library';
import { TAG_COLORS } from '~/core/tags';
import type { Tag } from '~/core/types';

/**
 * Amber is reserved for "open in a tab right now" — the one thing Chrome's manager cannot
 * tell you, and the only saturated colour in this UI. A tag wearing it would compete with
 * that signal everywhere a chip appears, so it is not offered here.
 */
const PICKABLE = TAG_COLORS.filter((color) => color !== 'amber');

/**
 * The tag editor: rename, recolour, delete.
 *
 * Sits in the pane the bookmark detail normally occupies, because the operations here need
 * room the 34px row cannot give — a colour row, a count broken out by status, and a delete
 * that has to say what it costs before you press it.
 */
export function TagDetail(props: { tag: Tag | undefined }) {
  const [error, setError] = createSignal<string | null>(null);
  const [confirming, setConfirming] = createSignal(false);

  const usage = () =>
    library.tagUsage().get(props.tag?.id ?? '') ?? { active: 0, inbox: 0, archived: 0, total: 0 };

  const parent = () => {
    const id = props.tag?.parent;
    return id === undefined ? undefined : library.tagsById().get(id);
  };

  // Moving the cursor to another tag must not carry a stale error, and must never leave a
  // primed Delete pointing at a tag you have not looked at.
  createEffect(() => {
    void props.tag?.id;
    setError(null);
    setConfirming(false);
  });

  const commitName = async (tag: Tag, value: string) => {
    const result = await library.renameTag(tag.id, value);
    setError(result.conflict === undefined ? null : `Already a tag called “${result.conflict}”.`);
  };

  const remove = async (tag: Tag) => {
    if (!confirming()) {
      setConfirming(true);
      return;
    }
    await library.deleteTag(tag.id);
  };

  return (
    <section class="pane detail">
      <Show
        when={props.tag}
        fallback={
          <div class="empty">
            <p class="empty__body">Select a tag to rename, recolour or remove it.</p>
          </div>
        }
      >
        {(tag) => (
          <>
            <h1 class="detail__title">
              <Show when={parent()}>{(p) => <span class="chip__parent">{p().name}</span>}</Show>
              {tag().name}
            </h1>

            <div class="detail__section">
              <div class="detail__label">Name</div>
              <input
                class="field__input tag-editor__name"
                type="text"
                value={tag().name}
                aria-invalid={error() !== null}
                onChange={(e) => void commitName(tag(), e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  // Abandon the edit and put the stored name back.
                  if (e.key === 'Escape') {
                    e.currentTarget.value = tag().name;
                    setError(null);
                    e.currentTarget.blur();
                  }
                }}
              />
              <Show when={error()}>
                {(message) => <p class="field__error">{message()}</p>}
              </Show>
              <p class="field__hint">
                Renaming touches no links — they store the tag, not its name.
              </p>
            </div>

            <div class="detail__section">
              <div class="detail__label">Colour</div>
              <div class="swatches">
                <For each={PICKABLE}>
                  {(color) => (
                    <button
                      type="button"
                      class="swatch"
                      data-color={color}
                      aria-label={color}
                      aria-pressed={tag().color === color}
                      style={{ '--tag-color': `var(--tag-${color})` }}
                      onClick={() => void library.setTagColor(tag().id, color)}
                    />
                  )}
                </For>
              </div>
            </div>

            <div class="detail__section">
              <div class="detail__label">On</div>
              <dl class="stat-grid">
                <dt>Library</dt>
                <dd>{usage().active}</dd>
                <dt>Inbox</dt>
                <dd>{usage().inbox}</dd>
                <dt>Archive</dt>
                <dd>{usage().archived}</dd>
              </dl>
              {/*
                Scoped by tag id, so the list it lands on is exactly these records — which
                is what lets the button carry the number. A search for the name would also
                match titles and URLs and deliver more rows than it promised.
              */}
              <Show when={usage().total > 0}>
                <button
                  type="button"
                  class="btn"
                  onClick={() => library.showRecordsForTag(tag().id)}
                >
                  Show {usage().total} {usage().total === 1 ? 'link' : 'links'}
                </button>
              </Show>
            </div>

            <div class="detail__section">
              {/*
                Two clicks, no dialog. There is no undo anywhere in this app, and taking a
                tag off several hundred records cannot be put back by hand — so the count
                has to be on the button at the moment of the decision, not one screen away.
              */}
              <button
                type="button"
                class="btn tag-editor__delete"
                data-confirming={confirming()}
                onClick={() => void remove(tag())}
              >
                <Show when={confirming()} fallback="Delete tag">
                  <Show
                    when={usage().total > 0}
                    fallback="Click again to delete"
                  >
                    Click again — removes it from {usage().total}{' '}
                    {usage().total === 1 ? 'link' : 'links'}
                  </Show>
                </Show>
              </button>
              <Show when={confirming()}>
                <button type="button" class="btn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </Show>
              <p class="field__hint">No link is deleted — only the tag comes off.</p>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
