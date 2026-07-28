import { findMatchingTab } from '~/core/tabs/match';
import { repository } from '~/core/db/idb-repository';
import {
  MANAGER_PAGE, SAVE_TABS_HASH, send, type Message, type OpenOrSwitchResult,
} from '~/shared/messages';

/**
 * Event-driven browser work only.
 *
 * MV3 terminates an idle worker after ~30s, so anything long-running — imports,
 * reindexing, dedupe sweeps — lives in a page context instead, where it cannot be
 * killed mid-operation. What stays here is short, event-triggered, and must work
 * even when no page is open: keyboard commands, action clicks, and open-or-switch.
 *
 * The one write this file performs is the open-count bump, which is a single atomic
 * `put`. It belongs here rather than in the caller because the popup closes the
 * instant it is clicked, which would otherwise cancel the update in flight.
 */

/**
 * Focus an existing tab showing this URL, or open a new one.
 *
 * Matching is conservative by design (see core/tabs/match.ts): opening a redundant
 * tab is a small annoyance, whereas focusing the wrong tab feels broken.
 */
async function openOrSwitch(url: string, bookmarkId?: string): Promise<OpenOrSwitchResult> {
  const tabs = await chrome.tabs.query({});
  const hit = findMatchingTab(tabs, url);

  let result: OpenOrSwitchResult;

  if (hit?.id != null) {
    await chrome.tabs.update(hit.id, { active: true });
    // Focus the window too — the match is frequently in a different one.
    if (hit.windowId != null) {
      await chrome.windows.update(hit.windowId, { focused: true });
    }
    result = { switched: true, tabId: hit.id };
  } else {
    const created = await chrome.tabs.create({ url });
    result = { switched: false, tabId: created.id ?? null };
  }

  if (bookmarkId) await recordOpen(bookmarkId);
  return result;
}

/** Single atomic put; safe to run in the worker even if the caller has gone away. */
async function recordOpen(bookmarkId: string): Promise<void> {
  try {
    const bookmark = await repository.get(bookmarkId);
    if (!bookmark) return;
    await repository.put({
      ...bookmark,
      lastOpenedAt: Date.now(),
      openCount: bookmark.openCount + 1,
    });
  } catch (error) {
    // Never let a stats update break navigation — the user got their tab either way.
    console.warn('[BookmarkGuru] could not record open', error);
  }
}

/**
 * Reuse the manager tab if one is already open rather than piling up duplicates.
 *
 * `hash` asks the page to do something on arrival. Match patterns ignore the fragment,
 * so the query below still finds an existing manager whatever hash it is carrying.
 */
async function openManager(hash = ''): Promise<{ ok: true }> {
  const url = chrome.runtime.getURL(MANAGER_PAGE);
  const [existing] = await chrome.tabs.query({ url });

  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true, ...(hash && { url: url + hash }) });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: url + hash });
  }
  return { ok: true };
}

/**
 * Route a tab capture to a manager page, because the write is far too big for a worker
 * that MV3 will kill after ~30s idle.
 *
 * Message first, so an already-open manager acts without its tab being navigated. Only
 * the manager answers this kind; every other surface ignores it, and `send` resolves
 * undefined when nobody replies — which is also what a manager still loading its
 * listeners looks like, hence the hash fallback rather than giving up.
 */
async function requestTabCapture(): Promise<void> {
  const answered = await send({ kind: 'save-open-tabs' });
  if (!answered) await openManager(SAVE_TABS_HASH);
}

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  switch (message.kind) {
    case 'open-or-switch':
      void openOrSwitch(message.url, message.bookmarkId).then(sendResponse);
      return true; // keep the channel open for the async reply

    case 'open-manager':
      void openManager().then(sendResponse);
      return true;

    case 'save-open-tabs':
      // Handled by the manager page. Ignored here so the worker never answers on its
      // behalf — a reply from the worker would look like the capture had been accepted.
      return false;

    case 'bookmarks-changed':
      // Broadcast for other surfaces; the worker itself holds no cache to invalidate.
      return false;

    default:
      return false;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-manager') void openManager();
  else if (command === 'save-open-tabs') void requestTabCapture();
});

chrome.runtime.onInstalled.addListener(() => {
  // The action button opens the capture popup, so the side panel needs its own entry.
  chrome.contextMenus.create({
    id: 'open-side-panel',
    title: 'Open BookmarkGuru side panel',
    contexts: ['action'],
  });
  chrome.contextMenus.create({
    id: 'open-manager',
    title: 'Open BookmarkGuru manager',
    contexts: ['action'],
  });
  // The keyboard command for this ships unbound, so this is its only default route.
  chrome.contextMenus.create({
    id: 'save-open-tabs',
    title: 'Save all open tabs to the inbox',
    contexts: ['action'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-manager') {
    void openManager();
  } else if (info.menuItemId === 'save-open-tabs') {
    void requestTabCapture();
  } else if (info.menuItemId === 'open-side-panel' && tab?.windowId != null) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
