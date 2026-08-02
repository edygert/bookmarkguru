/**
 * Minimal Chrome DevTools Protocol helpers.
 *
 * These drive a headless browser with the built extension loaded, which is the only
 * way to test the parts that unit tests cannot reach: manifest correctness, service
 * worker registration, chrome.* wiring, and whether the UI actually renders.
 *
 * Every bug that reached this project so far was found here rather than by `tsc`,
 * vitest, or the build — so this harness earns its keep.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens an extension page as a new tab and returns a connected session. */
export async function openPage(port, extId, path) {
  const url = `chrome-extension://${extId}/${path}`;
  const res = await fetch(`http://localhost:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  return connect((await res.json()).webSocketDebuggerUrl);
}

/** Connects to a DevTools websocket and exposes evaluate() plus captured errors. */
export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const errors = [];
  let id = 0;

  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const ready = new Promise((r) => (ws.onopen = r));

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description?.split('\n')[0]);
    }
  };

  /**
   * Always races a timeout. A hung evaluate is itself a finding — that is how the
   * service-worker registration failure first showed up (sendMessage never settled).
   */
  const evaluate = async (expression, ms = 8000) => {
    const r = await Promise.race([
      call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      wait(ms).then(() => ({ result: { value: '<<TIMEOUT>>' } })),
    ]);
    if (r?.exceptionDetails) {
      return `THREW: ${r.exceptionDetails.exception?.description?.split('\n')[0]}`;
    }
    return r?.result?.value;
  };

  return { ws, ready, call, evaluate, errors, close: () => ws.close() };
}

/** Starts a session ready for evaluation. */
export async function session(port, extId, path) {
  const s = await openPage(port, extId, path);
  await s.ready;
  await s.call('Runtime.enable');
  await wait(1200);
  return s;
}

/** Lists every target, including service workers (which /json/list omits). */
export async function allTargets(port) {
  const version = await (await fetch(`http://localhost:${port}/json/version`)).json();
  const s = connect(version.webSocketDebuggerUrl);
  await s.ready;
  const { targetInfos } = await s.call('Target.getTargets');
  s.close();
  return targetInfos;
}

/** Reads bookmarks + tags straight out of IndexedDB, resolving tag ids to names. */
export const READ_DB = `(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const getAll = (s) => new Promise((res, rej) => {
    const r = db.transaction(s).objectStore(s).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const [bookmarks, tags] = await Promise.all([getAll('bookmarks'), getAll('tags')]);
  const name = Object.fromEntries(tags.map(t => [t.id, t.name]));
  return JSON.stringify({
    count: bookmarks.length,
    tags: tags.map(t => t.name).sort(),
    items: bookmarks.map(b => ({
      title: b.title, domain: b.domain, status: b.status,
      folder: b.source.originalFolderPath, tags: b.tags.map(i => name[i]).sort(),
    })).sort((a, b) => a.title.localeCompare(b.title)),
  }, null, 2);
})()`;

export { wait };

/** Path-derived, so it is stable across runs for a given dist location. */
export const EXT_ID = process.env.BG_EXT_ID ?? 'mgiohfmbbflgjaclaaejknlbabafcmnb';
export const PORT = process.env.BG_PORT ?? '9500';
