/**
 * The search box, now that it is the only thing that narrows a list.
 *
 * A tag list, a domain list and an `Open now` toggle were all deleted, because each was a
 * second path to something `runQuery`'s text match already did. That is a cheap claim to
 * make and an expensive one to be wrong about: if typing a host does *not* narrow to that
 * host, the capability is simply gone and nothing on screen replaces it. `query.test.ts`
 * asserts the matching rules in plain node; what it cannot reach is the wiring — whether
 * the box is bound to the signal the list reads, and whether the deleted controls are
 * really absent rather than merely unstyled.
 *
 * Seeds its own records across two hosts and two tags, and narrows to them with a token
 * nothing else in the library can match, so the numbers hold no matter what earlier
 * scripts left behind.
 *
 * Runs after `tabs-test` because it wants a populated library, and before `tags-crud-test`
 * and `triage-test` because it destroys nothing and those two do.
 */
import { session, wait, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

/** A token nothing else in the library can match, so the list is exactly the seeds. */
const TOKEN = 'zqfilter';
const ALPHA = 'alpha.example';
const BETA = 'beta.example';

/**
 * Three records on ALPHA carrying `one`, two on BETA — one of which carries both tags.
 *
 * The tag names are deliberately *not* substrings of the titles or URLs: searching
 * `zqfilter-one` can only match through `tagNames`, so a broken tag-name lookup cannot
 * pass here by matching the title instead.
 */
const SEEDS = [
  { title: `${TOKEN} a1`, domain: ALPHA, tags: ['tag:zqf-one'] },
  { title: `${TOKEN} a2`, domain: ALPHA, tags: ['tag:zqf-one'] },
  { title: `${TOKEN} a3`, domain: ALPHA, tags: ['tag:zqf-one'] },
  { title: `${TOKEN} b1`, domain: BETA, tags: ['tag:zqf-one', 'tag:zqf-two'] },
  { title: `${TOKEN} b2`, domain: BETA, tags: ['tag:zqf-two'] },
];

console.log('seeding five active records across two hosts…');
const seeded = await s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const seeds = ${JSON.stringify(SEEDS)};
  const tx = db.transaction(['bookmarks', 'tags'], 'readwrite');
  tx.objectStore('tags').put({ id: 'tag:zqf-one', name: '${TOKEN}-one', color: 'slate' });
  tx.objectStore('tags').put({ id: 'tag:zqf-two', name: '${TOKEN}-two', color: 'blue' });
  seeds.forEach((seed, i) => {
    const url = 'https://' + seed.domain + '/${TOKEN}-' + i;
    tx.objectStore('bookmarks').put({
      id: 'bm:${TOKEN}-' + i,
      url, normalizedUrl: url, domain: seed.domain,
      title: seed.title, tags: seed.tags,
      // Descending, so the rendered order under the default createdAt-desc sort is
      // exactly the order of the array above.
      createdAt: 5000 - i, updatedAt: 5000 - i,
      lastOpenedAt: null, openCount: 0,
      status: 'active',
      source: { kind: 'manual' },
    });
  });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return seeds.length;
})()`);
console.log('seeded:', seeded);

await s.evaluate('location.reload()');
await wait(2500);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Click a view. Every `.nav-item` in the sidebar is one now — nothing else remains. */
const view = (label) => s.evaluate(`(() => {
  const b = [...document.querySelectorAll('.nav-item')]
    .find(x => x.textContent.includes(${JSON.stringify(label)}));
  if (!b) return 'NOT FOUND';
  b.click(); return 'clicked';
})()`);

const search = (text) => s.evaluate(`(() => {
  const input = document.querySelector('.search');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/** Titles currently rendered in the middle pane. */
const rows = async () =>
  JSON.parse(await s.evaluate(`JSON.stringify(
    [...document.querySelectorAll('.row__title')].map(e => e.textContent)
  )`));

/** Sidebar group headings — how a resurrected filter group would show itself. */
const headings = async () =>
  JSON.parse(await s.evaluate(`JSON.stringify(
    [...document.querySelectorAll('.sidebar__heading')].map(e => e.textContent.trim())
  )`));

/** Every button label in the toolbar. */
const toolbarButtons = async () =>
  JSON.parse(await s.evaluate(`JSON.stringify(
    [...document.querySelectorAll('.toolbar button')].map(e => e.textContent.trim())
  )`));

/** `openCount` for one seeded record, straight out of IndexedDB. */
const openCountOf = (id) => s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const rec = await new Promise((res, rej) => {
    const r = db.transaction('bookmarks').objectStore('bookmarks').get(${JSON.stringify(id)});
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return rec ? rec.openCount : 'NOT FOUND';
})()`);

const checks = [];
const check = (label, pass) => checks.push([label, pass]);

// ── the deleted controls really are gone ──────────────────────────────────────
await view('Library');
await wait(500);

const groups = await headings();
check('the sidebar has no Tags filter group', !groups.includes('Tags'));
check('the sidebar has no Domains group', !groups.includes('Domains'));

const buttons = await toolbarButtons();
check('the toolbar has no Open now toggle', !buttons.some((b) => b.startsWith('Open now')));
check('the toolbar has no Clear filters button', !buttons.includes('Clear filters'));

// ── typing narrows the way the deleted controls did ───────────────────────────
await search(TOKEN);
await wait(500);
check('search narrowed to the five seeded records', (await rows()).length === 5);

// What the domain filter did. The host is in `url`, not only in the `domain` field.
await search(ALPHA);
await wait(500);
const onAlpha = await rows();
check('typing a host narrows to that host', onAlpha.length === 3);
check('and to the right records', onAlpha.every((t) => /a[123]$/.test(t)));

await search(BETA);
await wait(500);
check('a different host selects a different set', (await rows()).length === 2);

// What the tag filter did. These names are in no title and no URL, so a match here can
// only have come through `tagNames`.
await search(`${TOKEN}-one`);
await wait(500);
check('typing a tag name narrows to that tag', (await rows()).length === 4);

await search(`${TOKEN}-two`);
await wait(500);
check('a different tag selects a different set', (await rows()).length === 2);

// What `all` mode did, in one string: every term must match, across any field.
await search(`${BETA} ${TOKEN}-one`);
await wait(500);
const both = await rows();
check('a host and a tag together intersect', both.length === 1);
check('and land on the record carrying both', both[0]?.endsWith('b1') === true);

// ── Enter after a mouse click activates exactly once ──────────────────────────
// Rows are `div role="option"`, not buttons, and `VirtualList` binds Enter on the
// container. A row that handled it too would activate twice, which shows up nowhere on
// screen — only as `openCount` climbing in pairs.
await search(`${TOKEN} a1`);
await wait(500);
const before = await openCountOf(`bm:${TOKEN}-0`);

await s.evaluate(`document.querySelectorAll('.row')[0].click()`);
await wait(300);
await s.evaluate(`(() => {
  const el = document.querySelector('.list');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
await wait(1200);

const after = await openCountOf(`bm:${TOKEN}-0`);
check('a click leaves the keyboard on the list', typeof after === 'number' && after > before);
check('Enter activated exactly once', after === before + 1);

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
