import { createSignal, Show } from 'solid-js';

/**
 * Favicons come from Chrome's own cache via the `favicon` permission — the extension
 * never makes a network request, so there is no `host_permissions` entry and the
 * install prompt never mentions reading data on websites.
 *
 * Coverage is partial by nature: a bulk-imported URL Chrome has never visited has no
 * cached icon, hence the neutral fallback.
 */
export function Favicon(props: { url: string; size?: number }) {
  const [failed, setFailed] = createSignal(false);

  const src = () => {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', props.url);
    u.searchParams.set('size', String(props.size ?? 16));
    return u.toString();
  };

  return (
    <Show
      when={!failed()}
      fallback={<div class="favicon favicon--fallback" aria-hidden="true" />}
    >
      <img
        class="favicon"
        src={src()}
        alt=""
        aria-hidden="true"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}
