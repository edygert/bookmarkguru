/**
 * Keyboard triage: `a` archives, `r` restores, `Delete` destroys.
 *
 * None of this lives in `src/core/`, so vitest cannot reach it — the transitions are
 * expressed through the Solid store, the status filter and IndexedDB, and every one of
 * those has produced a bug that type-checked cleanly. What is actually being asserted
 * here is not "the status field changed" but the two claims the feature makes:
 *
 *   1. the record leaves the list and the **next row takes its place**, cursor and
 *      detail pane included — a status write that left the cursor behind would look
 *      identical in the database and wrong in the hand;
 *   2. `Delete` is inert outside the Archive. It writes straight through to IndexedDB
 *      with no undo, so "does nothing here" is a correctness claim, not a nicety.
 *
 * Seeds its own records rather than reusing the ones earlier scripts left behind, and
 * narrows to them with the search box, so the assertions do not depend on how many rows
 * anything else happened to create. It still runs **last** in the chain: it is the only
 * script that deletes, and the others compute expectations from live state.
 */
import { session, wait, READ_DB, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

/** A token nothing else in the library can match, so the list is exactly the seeds. */
const TOKEN = 'zqtriage';
const TITLES = [`${TOKEN} one`, `${TOKEN} two`, `${TOKEN} three`];

console.log('seeding three active records…');
const seeded = await s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const titles = ${JSON.stringify(TITLES)};
  const tx = db.transaction('bookmarks', 'readwrite');
  titles.forEach((title, i) => {
    const url = 'https://triage.example/' + ${JSON.stringify(TOKEN)} + '-' + i;
    tx.objectStore('bookmarks').put({
      id: 'bm:${TOKEN}-' + i,
      url, normalizedUrl: url, domain: 'triage.example',
      title, tags: [],
      // Descending, so the rendered order under the default createdAt-desc sort is
      // exactly the order of this array and the assertions can name rows by index.
      createdAt: 3000 - i, updatedAt: 3000 - i,
      lastOpenedAt: null, openCount: 0,
      status: 'active',
      source: { kind: 'manual' },
    });
  });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return titles.length;
})()`);
console.log('seeded:', seeded);

await s.evaluate('location.reload()');
await wait(2500);

/** Click a view in the sidebar's first group — tag rows must not match by accident. */
const view = (label) => s.evaluate(`(() => {
  const group = document.querySelectorAll('.sidebar__group')[0];
  const b = [...group.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)}));
  if (!b) return 'NOT FOUND';
  b.click(); return 'clicked';
})()`);

/** Narrow to the seeded records. Search composes with the status view, so it survives one. */
const search = (text) => s.evaluate(`(() => {
  const input = document.querySelector('.search');
  input.value = ${JSON.stringify('')} + ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/**
 * Solid delegates keydown to the document, so a synthetic event dispatched on the list
 * reaches the handler by the same path a real keypress does.
 */
const press = (key) => s.evaluate(`(() => {
  const list = document.querySelector('.list');
  if (!list) return 'NO LIST';
  list.focus();
  list.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
  return true;
})()`);

const click = (index) => s.evaluate(`(() => {
  const row = document.querySelectorAll('.row')[${index}];
  if (!row) return 'NO ROW';
  row.click(); return true;
})()`);

/** What the middle pane shows, and what the detail pane says it is showing. */
const shown = async () => JSON.parse(await s.evaluate(`JSON.stringify({
  rows: [...document.querySelectorAll('.row__title')].map(e => e.textContent),
  detail: document.querySelector('.detail__title')?.textContent ?? null,
  hints: document.querySelector('.status-bar')?.textContent ?? '',
})`));

/** Just the seeded records, straight out of IndexedDB. */
const stored = async () => {
  const db = JSON.parse(await s.evaluate(READ_DB));
  const mine = db.items.filter((i) => i.title.startsWith(TOKEN));
  return { total: db.count, byTitle: Object.fromEntries(mine.map((i) => [i.title, i.status])) };
};

const checks = [];
const check = (label, pass) => checks.push([label, pass]);

// ── the library: `a` archives, and the next row takes the cursor ───────────────
await view('Library');
await search(TOKEN);
await wait(400);

const start = await shown();
check('search narrowed to the three seeded records', start.rows.length === 3);
check('rows render in seeded order', start.rows.join('|') === TITLES.join('|'));
check('Library hints offer archive, not delete',
  start.hints.includes('archive') && !start.hints.includes('delete'));

await click(0);
await wait(200);
const dbBefore = await stored();

await press('a');
await wait(600);

const afterArchive = await shown();
const dbAfterArchive = await stored();

check('archived record left the list', !afterArchive.rows.includes(TITLES[0]));
check('the next record took its place', afterArchive.rows[0] === TITLES[1]);
check('the detail pane followed the cursor', afterArchive.detail === TITLES[1]);
check('status is archived in IndexedDB', dbAfterArchive.byTitle[TITLES[0]] === 'archived');
check('nothing was deleted', dbAfterArchive.total === dbBefore.total);

// A second press without re-clicking: the pass repeats, which is the whole point.
await press('a');
await wait(600);

const afterSecond = await shown();
check('a second press archives without touching the mouse',
  (await stored()).byTitle[TITLES[1]] === 'archived');
check('cursor landed on the third record', afterSecond.rows[0] === TITLES[2]);
check('one record left in the library', afterSecond.rows.length === 1);

// ── `Delete` is inert on a record that is not archived ────────────────────────
const beforeInertDelete = await stored();
await press('Delete');
await wait(600);
check('Delete does nothing in the Library', (await stored()).total === beforeInertDelete.total);
check('the record is still there', (await shown()).rows.includes(TITLES[2]));

// ── the archive: `r` restores, `a` does nothing ───────────────────────────────
await view('Archive');
await wait(400);

const archived = await shown();
check('both archived records are in the Archive view',
  archived.rows.includes(TITLES[0]) && archived.rows.includes(TITLES[1]));
check('Archive hints offer restore and delete',
  archived.hints.includes('restore') && archived.hints.includes('delete'));

await click(0);
await wait(200);
const firstArchived = (await shown()).rows[0];

await press('a');
await wait(400);
check('`a` is a no-op on an already-archived record',
  (await stored()).byTitle[firstArchived] === 'archived');

await press('r');
await wait(600);
const afterRestore = await shown();
check('restored record left the Archive view', !afterRestore.rows.includes(firstArchived));
check('status is active again', (await stored()).byTitle[firstArchived] === 'active');

// ── the archive: `Delete` destroys ────────────────────────────────────────────
await click(0);
await wait(200);
const doomed = (await shown()).rows[0];
const beforeDelete = await stored();

await press('Delete');
await wait(800);

const afterDelete = await stored();
check('one record fewer in IndexedDB', afterDelete.total === beforeDelete.total - 1);
check('the record is gone, not merely filtered', afterDelete.byTitle[doomed] === undefined);
check('the row left the list', !(await shown()).rows.includes(doomed));

// Reload: a delete that only removed it from the Solid store would come back.
await s.evaluate('location.reload()');
await wait(2500);
check('still gone after a reload', (await stored()).byTitle[doomed] === undefined);

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
