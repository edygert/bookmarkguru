import { For, Show } from 'solid-js';
import { library } from '../state/library';
import { Favicon } from './Favicon';
import type { Bookmark } from '~/core/types';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDate(ts: number | null): string {
  return ts === null ? 'Never' : dateFmt.format(ts);
}

export function DetailPane(props: { bookmark: Bookmark | undefined }) {
  const tags = () =>
    (props.bookmark?.tags ?? [])
      .map((id) => library.tagsById().get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);

  return (
    <section class="pane detail">
      <Show
        when={props.bookmark}
        fallback={
          <div class="empty">
            <p class="empty__body">Select a link to see its details.</p>
          </div>
        }
      >
        {(bookmark) => (
          <>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '8px' }}>
              <Favicon url={bookmark().url} size={32} />
              <h1 class="detail__title">{bookmark().title}</h1>
            </div>

            <div class="detail__url">{bookmark().url}</div>

            <button
              type="button"
              class="btn btn--primary"
              onClick={() => void library.activate(bookmark())}
            >
              {library.isOpen(bookmark()) ? 'Switch to tab' : 'Open'}
            </button>

            <Show when={tags().length > 0}>
              <div class="detail__section">
                <div class="detail__label">Tags</div>
                <div style={{ display: 'flex', gap: '4px', 'flex-wrap': 'wrap' }}>
                  <For each={tags()}>
                    {(tag) => (
                      <span class="chip" style={{ '--tag-color': `var(--tag-${tag.color})` }}>
                        {tag.name}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <div class="detail__section">
              <div class="detail__label">Notes</div>
              <textarea
                class="notes"
                placeholder="Why is this worth keeping?"
                value={bookmark().notes}
                onChange={(e) =>
                  void library.updateBookmark(bookmark().id, { notes: e.currentTarget.value })
                }
              />
            </div>

            <div class="detail__section">
              <div class="detail__label">History</div>
              <dl class="stat-grid">
                <dt>Added</dt>
                <dd>{formatDate(bookmark().createdAt)}</dd>
                <dt>Last opened</dt>
                <dd>{formatDate(bookmark().lastOpenedAt)}</dd>
                <dt>Times opened</dt>
                <dd>{bookmark().openCount}</dd>
                <dt>Source</dt>
                <dd>{bookmark().source.kind}</dd>
              </dl>
            </div>

            <Show when={bookmark().source.originalFolderPath}>
              <div class="detail__section">
                <div class="detail__label">Imported from</div>
                <div class="detail__url">{bookmark().source.originalFolderPath}</div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
