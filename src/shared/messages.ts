/**
 * Typed messaging between extension contexts.
 *
 * A discriminated union plus the `send`/`broadcast` helpers below means a typo in a
 * message kind is a compile error rather than a silent no-op — the usual failure mode
 * of raw `chrome.runtime.sendMessage`.
 */

export type Message =
  /** Focus an existing tab for this URL, or open one. Handled by the service worker. */
  | { kind: 'open-or-switch'; url: string; bookmarkId?: string }
  /** Focus the manager page, opening it only if it isn't already open. */
  | { kind: 'open-manager' }
  /**
   * Capture every open tab into the inbox. Handled by the **manager page**, not the
   * worker: this is a bulk IndexedDB write and MV3 may terminate an idle worker
   * mid-operation. The worker's job is only to make sure a manager exists to hear it.
   */
  | { kind: 'save-open-tabs' }
  /** Fan-out after a write, so other open surfaces refresh. Fire-and-forget. */
  | { kind: 'bookmarks-changed'; ids: string[] };

export interface OpenOrSwitchResult {
  /** True when an existing tab was focused rather than a new one created. */
  switched: boolean;
  tabId: number | null;
}

/** Maps each message kind to what its handler resolves with. */
export interface ResultOf {
  'open-or-switch': OpenOrSwitchResult;
  'open-manager': { ok: true };
  'save-open-tabs': { ok: true };
  'bookmarks-changed': void;
}

/**
 * Send a message and await its reply.
 *
 * Swallows the "Receiving end does not exist" rejection, which is normal and not an
 * error: it just means no other context happened to be listening.
 */
export async function send<K extends Message['kind']>(
  message: Extract<Message, { kind: K }>,
): Promise<ResultOf[K] | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as ResultOf[K];
  } catch {
    return undefined;
  }
}

/** Fire-and-forget notification to whichever surfaces are open. */
export function broadcast(message: Message): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // No listener. Expected whenever the manager and panel are both closed.
  });
}

/** Relative to the extension root; resolve with chrome.runtime.getURL. */
export const MANAGER_PAGE = 'src/ui/manager.html';

/**
 * Asks a freshly opened manager to capture the open tabs.
 *
 * A hash rather than a second message because the worker cannot send to a page that has
 * not finished loading its listeners. The manager reads this on startup and strips it
 * immediately, so reloading the tab does not capture everything a second time.
 */
export const SAVE_TABS_HASH = '#save-open-tabs';
