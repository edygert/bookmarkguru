import { For, Show, createMemo, createSignal } from 'solid-js';
import { library } from '../state/library';
import { Favicon } from './Favicon';
import { tagIdFromName } from '~/core/ids';
import type { Bookmark, Tag } from '~/core/types';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDate(ts: number | null): string {
  return ts === null ? 'Never' : dateFmt.format(ts);
}

/** The folder a qualified tag was kept separate under, if it is one. */
function parentOf(tag: Tag): Tag | undefined {
  return tag.parent === undefined ? undefined : library.tagsById().get(tag.parent);
}

export function DetailPane(props: { bookmark: Bookmark | undefined }) {
  const [draft, setDraft] = createSignal('');

  const tags = () =>
    (props.bookmark?.tags ?? [])
      .map((id) => library.tagsById().get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);

  /**
   * The tag this name already resolves to, if any.
   *
   * Ids derive from names, so "Rust" typed here and a folder named `Rust` are the same
   * tag by construction — which is what stops hand-adding from quietly minting a second
   * tag beside the imported one.
   */
  const exact = () => {
    const clean = draft().trim();
    if (!clean) return undefined;
    const id = tagIdFromName(clean);
    return library.state.tags.find((t) => t.id === id);
  };

  const alreadyOn = () => {
    const match = exact();
    return match !== undefined && (props.bookmark?.tags.includes(match.id) ?? false);
  };

  /**
   * Candidates, best-used first — the count is shown so you attach the tag that already
   * has records rather than a near-duplicate that has one.
   */
  const suggestions = createMemo(() => {
    const needle = draft().trim().toLowerCase();
    if (!needle) return [];

    const current = new Set(props.bookmark?.tags ?? []);
    const usage = library.tagUsage();
    const byId = library.tagsById();

    return library.state.tags
      .filter((tag) => !current.has(tag.id) && tag.name.toLowerCase().includes(needle))
      .map((tag) => ({
        tag,
        parent: tag.parent === undefined ? undefined : byId.get(tag.parent),
        count: usage.get(tag.id)?.total ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
      .slice(0, 8);
  });

  const canCreate = () => draft().trim().length > 0 && exact() === undefined;

  const attach = async (bookmarkId: string, tagId: string) => {
    await library.addTagToBookmark(bookmarkId, tagId);
    setDraft('');
  };

  const create = async (bookmarkId: string) => {
    const tag = await library.createTag(draft());
    if (tag) await attach(bookmarkId, tag.id);
    setDraft('');
  };

  /** Enter takes the best candidate, or creates when there is none. */
  const onDraftKey = (e: KeyboardEvent, bookmarkId: string) => {
    if (e.key === 'Escape') {
      setDraft('');
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();

    const best = suggestions()[0];
    if (best) void attach(bookmarkId, best.tag.id);
    else if (canCreate()) void create(bookmarkId);
  };

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
            {/* Identity first, across the full width — the fields below it flow into
                columns, and a heading that flowed with them would be findable only by
                reading the column it happened to land in. */}
            <div class="detail__head">
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

            <div class="detail__section">
              <div class="detail__label">Tags</div>
              <div class="detail__chips">
                <For each={tags()}>
                  {(tag) => (
                    <span class="chip">
                      {/* A qualified tag names the folder it was kept separate under,
                          so two same-named tags read differently from each other. */}
                      <Show when={parentOf(tag)}>
                        {(parent) => (
                          <span class="chip__parent">{parent().name}</span>
                        )}
                      </Show>
                      {tag.name}
                      <button
                        type="button"
                        class="chip__remove"
                        aria-label={`Remove ${tag.name}`}
                        onClick={() =>
                          void library.removeTagFromBookmark(bookmark().id, tag.id)
                        }
                      >
                        ×
                      </button>
                    </span>
                  )}
                </For>
              </div>

              <input
                class="field__input detail__tag-input"
                type="text"
                placeholder="Add a tag…"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => onDraftKey(e, bookmark().id)}
              />

              <Show when={suggestions().length > 0}>
                <div class="suggestions">
                  <For each={suggestions()}>
                    {(row) => (
                      <button
                        type="button"
                        class="suggestion"
                        onClick={() => void attach(bookmark().id, row.tag.id)}
                      >
                        <span class="suggestion__label">
                          <Show when={row.parent}>
                            {(parent) => <span class="chip__parent">{parent().name}</span>}
                          </Show>
                          {row.tag.name}
                        </span>
                        <span class="suggestion__count">{row.count}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={canCreate()}>
                <button
                  type="button"
                  class="btn"
                  onClick={() => void create(bookmark().id)}
                >
                  Create “{draft().trim()}”
                </button>
              </Show>

              {/* An exact match that is already on this link produces neither a
                  suggestion nor a Create, which would otherwise look like a dead input. */}
              <Show when={alreadyOn()}>
                <p class="field__hint">Already on this link.</p>
              </Show>
            </div>

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
