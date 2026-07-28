import { render } from 'solid-js/web';
import { Show, createSignal, onMount } from 'solid-js';
import { repository } from '~/core/db/idb-repository';
import { domainOf, isIngestable, normalizeForDedupe } from '~/core/normalize-url';
import { newId, tagIdFromName } from '~/core/ids';
import { colorForTag } from '~/core/tags';
import { broadcast, send } from '~/shared/messages';
import type { Bookmark, Tag } from '~/core/types';
import './styles/app.css';

/**
 * Save the current tab.
 *
 * Small surface, high daily value: capture is how the library actually grows.
 * Writes go straight to IndexedDB from here — a single `put` is atomic and fast
 * enough to complete before the popup closes.
 */
function Popup() {
  const [url, setUrl] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [tagText, setTagText] = createSignal('');
  const [existing, setExisting] = createSignal<Bookmark | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return setReady(true);

    setUrl(tab.url);
    setTitle(tab.title ?? tab.url);

    if (isIngestable(tab.url)) {
      const matches = await repository.findByNormalizedUrl(normalizeForDedupe(tab.url));
      setExisting(matches[0] ?? null);
    }
    setReady(true);
  });

  const save = async () => {
    const now = Date.now();
    const names = tagText().split(',').map((t) => t.trim()).filter(Boolean);
    const tagIds = names.map(tagIdFromName);

    if (names.length > 0) {
      const known = new Set((await repository.getTags()).map((t) => t.id));
      const fresh: Tag[] = names
        .filter((name) => !known.has(tagIdFromName(name)))
        .map((name) => ({ id: tagIdFromName(name), name, color: colorForTag(name) }));
      if (fresh.length) await repository.putTags(fresh);
    }

    const current = existing();
    if (current) {
      // Already saved — merge the new tags rather than creating a duplicate.
      await repository.put({
        ...current,
        tags: [...new Set([...current.tags, ...tagIds])],
        updatedAt: now,
      });
    } else {
      await repository.put({
        id: newId(),
        url: url(),
        normalizedUrl: normalizeForDedupe(url()),
        domain: domainOf(url()),
        title: title().trim() || url(),
        description: '',
        notes: '',
        tags: tagIds,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: null,
        openCount: 0,
        favorite: false,
        pinned: false,
        status: 'active',
        source: { kind: 'manual' },
      });
    }

    broadcast({ kind: 'bookmarks-changed', ids: [] });
    setSaved(true);
    setTimeout(() => window.close(), 600);
  };

  const canSave = () => ready() && url() !== '' && isIngestable(url());

  return (
    <div class="popup">
      <Show when={ready()} fallback={<div class="field__label">Loading…</div>}>
        {/*
          No fallback. On a page that cannot be saved — a chrome:// page, the extension's
          own tabs, the new tab page — the popup simply offers to open the library.

          It used to explain why saving was unavailable, which read as an error report for
          something the user had not asked for: opening the popup on chrome://extensions
          right after installing announced a failure as the first thing the extension ever
          said. The absent Save button is explanation enough.
        */}
        <Show when={canSave()}>
          <Show when={existing()}>
            <div class="field__label" style={{ color: 'var(--signal)' }}>
              Already saved — adding tags will update it
            </div>
          </Show>

          <div class="field">
            <label class="field__label" for="title">Title</label>
            <input
              id="title"
              class="field__input"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </div>

          <div class="field">
            <label class="field__label" for="tags">Tags</label>
            <input
              id="tags"
              class="field__input"
              placeholder="comma, separated"
              value={tagText()}
              onInput={(e) => setTagText(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            />
          </div>

          <button type="button" class="btn btn--primary" onClick={() => void save()}>
            {saved() ? 'Saved' : existing() ? 'Update' : 'Save'}
          </button>
        </Show>

        <button
          type="button"
          class="btn"
          onClick={async () => {
            // Await before closing: tearing down the popup mid-send cancels the
            // message, and the manager would never open.
            await send({ kind: 'open-manager' });
            window.close();
          }}
        >
          Open BookmarkGuru
        </button>
      </Show>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from popup.html');

render(() => <Popup />, root);
