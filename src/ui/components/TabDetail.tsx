import { For, Show } from 'solid-js';
import { Favicon } from './Favicon';
import { library, type OpenTab } from '../state/library';

/**
 * The selected open tab.
 *
 * The detail pane for a selected open tab, sharing the slot with `DetailPane`; the Tags
 * view has no pane there. It exists so a tab's extra attributes — its group, its window,
 * whether it is already saved — have
 * a home off the row: with a detail pane per view, every list is title-and-domain rows and
 * the attributes live in one place.
 *
 * `tags` are what a capture would write, from `sourceTagsFor`. A saved tab shows the tags
 * on its *record* instead, since those are what it actually carries.
 */
export function TabDetail(props: { tab: OpenTab | undefined }) {
  const record = () => {
    const id = props.tab?.bookmarkId;
    return id === undefined ? undefined : library.state.bookmarks.find((b) => b.id === id);
  };

  const recordTags = () =>
    (record()?.tags ?? [])
      .map((id) => library.tagsById().get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);

  return (
    <section class="pane detail">
      <Show
        when={props.tab}
        fallback={
          <div class="empty">
            <p class="empty__body">Select a tab to see its details.</p>
          </div>
        }
      >
        {(tab) => (
          <>
            <div class="detail__head">
              <Favicon url={tab().url} size={32} />
              <h1 class="detail__title">{tab().title}</h1>
            </div>

            <div class="detail__url">{tab().url}</div>

            <button
              type="button"
              class="btn btn--primary"
              onClick={() => void library.focusTab(tab())}
            >
              Switch to tab
            </button>

            <Show when={tab().saveable && tab().bookmarkId === undefined}>
              <button type="button" class="btn" onClick={() => void library.saveTabs([tab()])}>
                Save to inbox
              </button>
            </Show>

            <div class="detail__section">
              <div class="detail__label">{record() ? 'Tags' : 'Tags on save'}</div>
              <div class="detail__chips">
                <Show
                  when={record()}
                  fallback={
                    <For each={tab().tags} fallback={<span class="field__hint">None.</span>}>
                      {(tag) => (
                        <span class="chip">{tag.name}</span>
                      )}
                    </For>
                  }
                >
                  <For each={recordTags()} fallback={<span class="field__hint">None.</span>}>
                    {(tag) => (
                      <span class="chip">{tag.name}</span>
                    )}
                  </For>
                </Show>
              </div>
            </div>

          </>
        )}
      </Show>
    </section>
  );
}
