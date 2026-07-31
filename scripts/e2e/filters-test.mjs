/**
 * The filter sidebar: domains, the tag all/any switch, and Clear filters.
 *
 * `runQuery` already honoured `domains` and `tagMode` before any of this shipped, and
 * `query.test.ts` covers that in plain node. What cannot be reached from there is
 * everything this feature actually is — a count rendered beside a control, a store
 * update, and whether the list that comes back is the list the control promised.
 *
 * The assertion that earns this file is the first one. **A count beside a control has to
 * be the count that control delivers** — the rule that came out of a sidebar row
 * advertising 171 open tabs next to a filter over bookmarks and producing an empty list.
 * `domainCounts` computes every domain's number from one pipeline run rather than one run
 * per domain, and an off-by-one in that bucketing is invisible to `tsc`, to vitest, and to
 * anyone reading the diff: both numbers are perfectly good integers.
 *
 * Seeds its own records across two domains and two tags and narrows to them with the
 * search box. That is not only for isolation: `domainCounts` honours the query, so the
 * Domains group narrows to the seeded domains too, which is what makes the numbers here
 * predictable no matter what earlier scripts left in the library.
 *
 * Runs after `tabs-test` because it wants a populated library, and before `tags-crud-test`
 * and `triage-test` because it destroys nothing and those two do.
 */
import { session, wait, READ_DB, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

/** A token nothing else in the library can match, so the list is exactly the seeds. */
const TOKEN = 'zqfilter';
const ALPHA = 'alpha.example';
const BETA = 'beta.example';

/**
 * Three records on ALPHA carrying `one`, two on BETA — one of which carries both tags.
 *
 * Chosen so `all` and `any` cannot coincide: both tags together select exactly the one
 * BETA record, either tag selects all five. A seed where the two modes agree would let a
 * switch that does nothing pass.
 */
const SEEDS = [
  { title: `${TOKEN} a1`, domain: ALPHA, tags: ['tag:zqf-one'] },
  { title: `${TOKEN} a2`, domain: ALPHA, tags: ['tag:zqf-one'] },
  { title: `${TOKEN} a3`, domain: ALPHA, tags: ['tag:zqf-one'] },
  { title: `${TOKEN} b1`, domain: BETA, tags: ['tag:zqf-one', 'tag:zqf-two'] },
  { title: `${TOKEN} b2`, domain: BETA, tags: ['tag:zqf-two'] },
];

console.log('seeding five active records across two domains…');
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
      title: seed.title, description: '', notes: '', tags: seed.tags,
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

/** Click a view in the sidebar's first group — tag and domain rows must not match. */
const view = (label) => s.evaluate(`(() => {
  const group = document.querySelectorAll('.sidebar__group')[0];
  const b = [...group.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)}));
  if (!b) return 'NOT FOUND';
  b.click(); return 'clicked';
})()`);

const search = (text) => s.evaluate(`(() => {
  const input = document.querySelector('.search');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/**
 * A group by its heading. The Tags heading also contains the all/any switch, so this
 * matches on the leading text rather than the whole thing.
 */
const groupOf = (name) => `[...document.querySelectorAll('.sidebar__group')]
  .find(g => (g.querySelector('.sidebar__heading')?.textContent ?? '').trim().startsWith(${JSON.stringify(name)}))`;

/** The count rendered beside a row, as the sidebar shows it. */
const countIn = async (group, label) => {
  const raw = await s.evaluate(`(() => {
    const g = ${groupOf(group)};
    if (!g) return 'NO GROUP';
    const row = [...g.querySelectorAll('.nav-item')]
      .find(n => n.querySelector('.nav-item__label')?.textContent.trim() === ${JSON.stringify(label)});
    return row ? row.querySelector('.nav-item__count').textContent.trim() : 'NO ROW';
  })()`);
  return /^\d+$/.test(raw) ? Number(raw) : raw;
};

const clickIn = (group, label) => s.evaluate(`(() => {
  const g = ${groupOf(group)};
  if (!g) return 'NO GROUP';
  const row = [...g.querySelectorAll('.nav-item')]
    .find(n => n.querySelector('.nav-item__label')?.textContent.trim() === ${JSON.stringify(label)});
  if (!row) return 'NO ROW';
  row.click(); return 'clicked';
})()`);

/** Whether a domain row exists at all — the fail-visible claim. */
const hasRow = (group, label) => s.evaluate(`(() => {
  const g = ${groupOf(group)};
  if (!g) return false;
  return [...g.querySelectorAll('.nav-item')]
    .some(n => n.querySelector('.nav-item__label')?.textContent.trim() === ${JSON.stringify(label)});
})()`);

const setTagMode = (mode) => s.evaluate(`(() => {
  const b = [...document.querySelectorAll('.segmented__option')]
    .find(x => x.textContent.trim() === ${JSON.stringify(mode)});
  if (!b) return 'NOT FOUND';
  b.click(); return 'clicked';
})()`);

const clearFilters = () => s.evaluate(`(() => {
  const b = [...document.querySelectorAll('.toolbar .btn')]
    .find(x => x.textContent.trim() === 'Clear filters');
  if (!b) return 'NOT FOUND';
  b.click(); return 'clicked';
})()`);

const hasClear = () => s.evaluate(`[...document.querySelectorAll('.toolbar .btn')]
  .some(x => x.textContent.trim() === 'Clear filters')`);

/** Titles currently rendered in the middle pane. */
const rows = async () =>
  JSON.parse(await s.evaluate(`JSON.stringify(
    [...document.querySelectorAll('.row__title')].map(e => e.textContent)
  )`));

/** Click the domain on a rendered row — the in-list filter control. */
const clickRowDomain = (index) => s.evaluate(`(() => {
  const el = document.querySelectorAll('.row__domain--filter')[${index}];
  if (!el) return 'NO DOMAIN BUTTON';
  el.click(); return 'clicked';
})()`);

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

// ── the domain count is the count the domain row delivers ─────────────────────
await view('Library');
await search(TOKEN);
await wait(500);

const seedRows = await rows();
check('search narrowed to the five seeded records', seedRows.length === 5);

const alphaCount = await countIn('Domains', ALPHA);
const betaCount = await countIn('Domains', BETA);
check(`the Domains group lists ${ALPHA} with a count`, alphaCount === 3);
check(`the Domains group lists ${BETA} with a count`, betaCount === 2);

await clickIn('Domains', ALPHA);
await wait(500);
const afterAlpha = await rows();

// The assertion this file exists for. Not "three rows" — the number the control showed.
check('the domain count equals the rows the domain delivers', afterAlpha.length === alphaCount);
check('every remaining row is from that domain',
  afterAlpha.every((t) => t.endsWith('a1') || t.endsWith('a2') || t.endsWith('a3')));

// Domains OR together: a record has one domain, so the counts are additive.
await clickIn('Domains', BETA);
await wait(500);
check('a second domain ORs rather than intersecting',
  (await rows()).length === alphaCount + betaCount);

await clearFilters();
await wait(500);
check('Clear filters restored the full result', (await rows()).length === 5);
check('Clear filters hides itself once nothing is on', (await hasClear()) === false);

// ── a row's own domain filters to it ──────────────────────────────────────────
await clickRowDomain(0);
await wait(500);
const fromRow = await rows();
check('clicking a row domain narrows to that domain', fromRow.length === 3);
check('clicking a row domain replaces rather than accumulates',
  (await countIn('Domains', ALPHA)) === 3 && fromRow.every((t) => t.includes('a')));
check('Clear filters appeared once a filter was on', (await hasClear()) === true);

await clearFilters();
await wait(400);

// ── an active domain with nothing left in it stays visible ────────────────────
// ALPHA carries no `two` tag, so this pair selects nothing. The point is that the
// domain row survives at zero: dropping it would strip the only control able to
// undo the filter, leaving an empty library and no way to read why.
await clickIn('Domains', ALPHA);
await wait(300);
await clickIn('Tags', `${TOKEN}-two`);
await wait(500);

check('the combination really is empty', (await rows()).length === 0);
check('a zero-count domain stays on the list', (await hasRow('Domains', ALPHA)) === true);
check('and reports zero rather than a stale number',
  (await countIn('Domains', ALPHA)) === 0);

await clearFilters();
await wait(400);

// ── the all/any switch ────────────────────────────────────────────────────────
await clickIn('Tags', `${TOKEN}-one`);
await wait(300);
await clickIn('Tags', `${TOKEN}-two`);
await wait(300);

await setTagMode('all');
await wait(500);
const all = await rows();

await setTagMode('any');
await wait(500);
const any = await rows();

check('`all` requires every selected tag', all.length === 1);
check('`any` requires only one of them', any.length === 5);
check('the `all` set is a subset of the `any` set', all.every((t) => any.includes(t)));

// The switch is a preference, not a selection: it has to outlive a view change, or
// the mode silently reverts under you every time you visit the Inbox.
await view('Inbox');
await wait(300);
await view('Library');
await wait(300);
const modeAfterViews = await s.evaluate(`(() => {
  const b = [...document.querySelectorAll('.segmented__option')]
    .find(x => x.getAttribute('aria-pressed') === 'true');
  return b ? b.textContent.trim() : 'NONE';
})()`);
check('the all/any choice survives a view switch', modeAfterViews === 'any');

// ── switching views drops the domain filter ───────────────────────────────────
await search(TOKEN);
await wait(400);
await clickIn('Domains', ALPHA);
await wait(400);
check('domain filter is on before the view switch', (await rows()).length === 3);

await view('Inbox');
await wait(300);
await view('Library');
await wait(500);
check('switching views cleared the domain filter', (await rows()).length === 5);

// ── Enter after a mouse click activates exactly once ──────────────────────────
// Rows stopped being `<button>` so the domain control could nest inside one. A focusable
// row plus the list's own Enter handler is two paths to `activate`, and the difference
// shows up nowhere on screen — only as `openCount` climbing in pairs.
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
