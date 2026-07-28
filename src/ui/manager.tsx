import { render } from 'solid-js/web';
import { App } from './App';
import { library } from './state/library';
import { SAVE_TABS_HASH, type Message } from '~/shared/messages';
import './styles/app.css';

/**
 * The manager page owns bulk captures.
 *
 * Not the service worker, for the standing reason: MV3 terminates an idle worker after
 * ~30s, and capturing a few hundred tabs is exactly the write that would be killed
 * halfway. The worker only arranges for this page to exist and hear about it — by
 * message when a manager is already open, by URL hash when one has to be created.
 */
async function captureOpenTabs(): Promise<void> {
  // Both awaits matter when the request arrives before <App> has mounted. Capturing
  // against an unloaded store would find no existing records to dedupe against and
  // write a second copy of everything already saved.
  await library.load();
  await library.refreshOpenTabs();

  library.showTabs();
  await library.saveAllOpenTabs();
}

/** Only the manager answers this kind; the worker falls back to the hash if nobody does. */
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message?.kind !== 'save-open-tabs') return false;
  void captureOpenTabs();
  sendResponse({ ok: true });
  return false;
});

/**
 * Strip the hash *before* acting on it, so reloading the tab — or restoring the session
 * next time the browser starts — does not silently capture everything again.
 */
function consumeSaveTabsHash(): void {
  if (location.hash !== SAVE_TABS_HASH) return;
  history.replaceState(null, '', location.pathname + location.search);
  void captureOpenTabs();
}

window.addEventListener('hashchange', consumeSaveTabsHash);
consumeSaveTabsHash();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from manager.html');

render(() => <App />, root);
