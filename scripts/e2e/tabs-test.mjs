/**
 * The open-tabs view and the capture it feeds.
 *
 * Two of these assertions exist because of a specific shipped bug: the sidebar showed
 * the number of open browser *tabs* on a control that filtered *bookmarks*, so it read
 * "171" and produced an empty list. Any count sitting next to a control has to be the
 * count that control delivers, and that is not something a type checker can notice —
 * both numbers are perfectly good integers.
 *
 * Runs last, so the library already holds records from the earlier scripts. It computes
 * every expectation from live state rather than hardcoding totals, because how many
 * tabs the previous scripts left open is not something to depend on.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session, wait, EXT_ID, PORT } from './cdp.mjs';

const DIR = join(tmpdir(), 'bookmarkguru-e2e', 'pages');
mkdirSync(DIR, { recursive: true });
for (const n of [1, 2, 3]) {
  writeFileSync(join(DIR, `tab${n}.html`), `<title>Tab Page ${n}</title><h1>Tab ${n}</h1>`);
}
const urls = [1, 2, 3].map((n) => `file://${join(DIR, `tab${n}.html`)}`);

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

// ── seed: three tabs, two of them in a titled group ───────────────────────────
console.log('opening tabs and grouping two of them…');
const grouped = await s.evaluate(`(async () => {
  const made = [];
  for (const u of ${JSON.stringify(urls)}) {
    made.push(await chrome.tabs.create({ url: u, active: false }));
  }
  const gid = await chrome.tabs.group({ tabIds: [made[0].id, made[1].id] });
  await chrome.tabGroups.update(gid, { title: 'E2E Group', color: 'cyan' });
  return true;
})()`);
console.log('grouped:', grouped);

await s.evaluate('location.reload()');
await wait(2500);

// Parenthesised deliberately: `a ?? b || c` is a SyntaxError, and an evaluate that
// throws comes back as a string, so the mistake shows up as a quiet NaN downstream.
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? '')`;
const navItem = (label) => `[...document.querySelectorAll('.nav-item')]
  .find(n => n.querySelector('.nav-item__label')?.textContent.trim() === ${JSON.stringify(label)})`;

// ── counts, before touching anything ──────────────────────────────────────────
const liveTabs = JSON.parse(await s.evaluate(`chrome.tabs.query({}).then(ts => JSON.stringify({
  total: ts.filter(t => t.url).length,
  saveable: ts.filter(t => t.url && /^(https?|file|ftp):/.test(t.url)).length,
}))`));

const sidebarTabCount = Number(await s.evaluate(
  `${navItem('Open tabs')}?.querySelector('.nav-item__count')?.textContent ?? 'NaN'`));
const toggleCount = Number(await s.evaluate(`${text('.toggle__count')} || 'NaN'`) ?? 'NaN');

/** Bookmarks whose URL is open right now — what the "Open now" filter must yield. */
const reallyOpen = Number(await s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const stored = await new Promise((res, rej) => {
    const r = db.transaction('bookmarks').objectStore('bookmarks').getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tabs = await chrome.tabs.query({});
  const open = new Set(tabs.map(t => t.url).filter(Boolean));
  return stored.filter(b => open.has(b.url)).length;
})()`));

console.log('\n=== COUNTS ===');
console.log('  open tabs (chrome) :', liveTabs.total);
console.log('  sidebar "Open tabs":', sidebarTabCount);
console.log('  toolbar "Open now" :', toggleCount);
console.log('  bookmarks open now :', reallyOpen);

// The regression itself: these two numbers were the same control's, and were not equal.
const sidebarHasOpenNow = await s.evaluate(`!!${navItem('Open now')}`);

// ── the view ──────────────────────────────────────────────────────────────────
await s.evaluate(`${navItem('Open tabs')}?.click()`);
await wait(1200);

const tabRows = Number(await s.evaluate(`document.querySelectorAll('.row--tab').length`));
const groupChips = await s.evaluate(
  `[...document.querySelectorAll('.row--tab .chip')].map(c => c.textContent.trim())`);
const noAmber = await s.evaluate(
  `[...document.querySelectorAll('.row--tab')].every(r => r.dataset.open === undefined)`);
const saveButtons = Number(await s.evaluate(
  `document.querySelectorAll('.row--tab .row__action').length`));
const captureLabel = await s.evaluate(
  `[...document.querySelectorAll('.toolbar button')].map(b => b.textContent.trim()).join(' | ')`);

console.log('\n=== OPEN TABS VIEW ===');
console.log('  tab rows           :', tabRows);
console.log('  group chips        :', JSON.stringify(groupChips));
console.log('  per-row Save shown :', saveButtons);
console.log('  capture button     :', captureLabel);

const promised = Number(/Save (\d+) tabs/.exec(captureLabel)?.[1] ?? 'NaN');

// ── capture ───────────────────────────────────────────────────────────────────
const before = Number(await s.evaluate(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('bookmarkguru'); r.onsuccess = () => res(r.result); });
  return new Promise((res) => { const r = db.transaction('bookmarks').objectStore('bookmarks').count(); r.onsuccess = () => res(r.result); });
})()`));

await s.evaluate(`[...document.querySelectorAll('.toolbar button')]
  .find(b => /^Save \\d+ tabs$/.test(b.textContent.trim()))?.click()`);
await wait(3000);

/**
 * A write failure surfaces as a banner, not as a thrown error — `runImport` catches and
 * stores the message. Worth its own assertion: this is where a second write into a
 * non-empty store handed IndexedDB a Solid store proxy and got back
 * "#<Object> could not be cloned", with every count silently reading zero.
 */
const failed = await s.evaluate(
  `[...document.querySelectorAll('main .empty__title')].some(e => /went wrong/.test(e.textContent))`);
const errorBanner = failed
  ? await s.evaluate(`${text('main .empty__body')} || '(unreadable)'`)
  : '(none)';

const after = JSON.parse(await s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const getAll = (s) => new Promise((res) => {
    const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result);
  });
  const [bookmarks, tags] = await Promise.all([getAll('bookmarks'), getAll('tags')]);
  const name = Object.fromEntries(tags.map(t => [t.id, t.name]));
  // A captured tab is the only record carrying the window it was open in.
  const captured = bookmarks.filter(b => b.source.windowId !== undefined);
  return JSON.stringify({
    total: bookmarks.length,
    captured: captured.length,
    allInbox: captured.every(b => b.status === 'inbox'),
    tags: [...new Set(captured.flatMap(b => b.tags.map(i => name[i])))].sort(),
    windowIds: [...new Set(captured.map(b => b.source.windowId))].filter(v => v !== undefined).length,
    internal: captured.filter(b => /^(chrome|chrome-extension|about):/.test(b.url)).length,
    duplicated: bookmarks.length !== new Set(bookmarks.map(b => b.normalizedUrl)).size,
  });
})()`));

console.log('\n=== AFTER CAPTURE ===');
console.log('  records before/after:', before, '/', after.total);
console.log('  tab-import records  :', after.captured);
console.log('  their tags          :', JSON.stringify(after.tags));
console.log('  all in inbox        :', after.allInbox);
console.log('  browser-internal    :', after.internal);
console.log('  error banner        :', errorBanner);

// ── the standing command's message route ──────────────────────────────────────
/**
 * `save-open-tabs` is answered by the manager page, never by the worker — the write is
 * far too big for something MV3 will kill after ~30s idle. Sent from the panel, because
 * `chrome.runtime.sendMessage` does not deliver back to the context that sent it, so
 * the manager cannot test its own listener.
 */
writeFileSync(join(DIR, 'tab-late.html'), '<title>Opened Later</title><h1>later</h1>');
const panel = await session(PORT, EXT_ID, 'src/ui/panel.html');
await panel.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(
  `file://${join(DIR, 'tab-late.html')}`)}, active: false })`);
await wait(1500);

const ack = await panel.evaluate(`chrome.runtime.sendMessage({ kind: 'save-open-tabs' })`);
await wait(3000);

const lateCaptured = await s.evaluate(`(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('bookmarkguru'); r.onsuccess = () => res(r.result); });
  const all = await new Promise((res) => {
    const r = db.transaction('bookmarks').objectStore('bookmarks').getAll(); r.onsuccess = () => res(r.result);
  });
  return all.some(b => b.url.endsWith('tab-late.html'));
})()`);

console.log('\n=== COMMAND ROUTE ===');
console.log('  manager acknowledged:', JSON.stringify(ack));
console.log('  later tab captured  :', lateCaptured);

const checks = [
  ['a write into a non-empty store does not fail', errorBanner === '(none)'],
  ['the manager, not the worker, answers save-open-tabs', ack?.ok === true],
  ['the command captures a tab opened after the first pass', lateCaptured === true],
  ['"Open now" is no longer a sidebar view', sidebarHasOpenNow === false],
  ['sidebar "Open tabs" count matches the browser', sidebarTabCount === liveTabs.total],
  ['"Open now" counts bookmarks, not tabs', toggleCount === reallyOpen],
  ['…and that is a different number from the tab count', toggleCount !== liveTabs.total],
  ['every open tab is listed', tabRows === liveTabs.total],
  ['a tab group renders as a chip', groupChips.includes('E2E Group')],
  ['no row claims the amber open-now state', noAmber === true],
  ['unsaveable tabs get no Save action', saveButtons < tabRows],
  ['the capture button promises what it adds', promised === after.total - before],
  ['captures land in the inbox', after.captured > 0 && after.allInbox],
  ['captures are tagged by group and window',
    after.tags.includes('E2E Group') && after.tags.some((t) => /^Window \d+$/.test(t))],
  ['the window is recorded on the record too', after.windowIds > 0],
  ['browser-internal pages were not captured', after.internal === 0],
  ['nothing already saved was duplicated', after.duplicated === false],
];

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
const errs = [...s.errors, ...panel.errors];
console.log('\nerrors:', errs.length ? errs.join('\n') : '(none)');
process.exit(ok && !errs.length ? 0 : 1);
