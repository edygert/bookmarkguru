/**
 * Tag editing: create, attach, detach, rename, recolour, delete.
 *
 * None of this is reachable from vitest. The transitions run through the Solid store, the
 * tag view and IndexedDB, and the interesting claims are all about what *did not* happen:
 *
 *   1. **Renaming a tag writes no bookmark record.** That is the entire justification for
 *      `Bookmark.tags` holding ids, and the only way to see it is to read the record's raw
 *      tag ids back out of IndexedDB before and after — resolved to names they would look
 *      identical either way.
 *   2. **A tag on zero records is still reachable.** The sidebar hides it by design, so if
 *      the tag view hid it too the tag would exist in the database with no surface able to
 *      delete it. A DOM-only assertion cannot tell "absent" from "never written".
 *   3. **Deleting a tag deletes no link.** It is the one destructive act here and it has no
 *      undo, so "the bookmark count is unchanged" is a correctness claim.
 *
 * Seeds its own record and its own tags, so it disturbs nothing the earlier scripts count.
 * Runs after `tabs-test` (which wants a populated library) and before `triage-test`, which
 * stays last because it is the only script that destroys records.
 */
import { session, wait, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

/** Tokens nothing else in the library or its tags can match. */
const TOKEN = 'zqtagseed';
const ALPHA = 'zqtagalpha';
const BETA = 'zqtagbeta';
const GAMMA = 'zqtaggamma';

console.log('seeding one untagged record…');
await s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const url = 'https://tagcrud.example/${TOKEN}';
  const tx = db.transaction('bookmarks', 'readwrite');
  tx.objectStore('bookmarks').put({
    id: 'bm:${TOKEN}',
    url, normalizedUrl: url, domain: 'tagcrud.example',
    title: '${TOKEN} one', description: '', notes: '', tags: [],
    createdAt: 4000, updatedAt: 4000,
    lastOpenedAt: null, openCount: 0,
    status: 'active',
    source: { kind: 'manual' },
  });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return true;
})()`);

await s.evaluate('location.reload()');
await wait(2500);

/**
 * Raw tag records and the seeded record's raw tag **ids**.
 *
 * Deliberately not `READ_DB`, which resolves ids to names — that mapping is exactly what
 * a rename changes, so reading through it would make "the record was not rewritten"
 * unfalsifiable.
 */
const stored = async () =>
  JSON.parse(await s.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('bookmarkguru');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res, rej) => {
      const r = db.transaction(s).objectStore(s).getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const [bookmarks, tags] = await Promise.all([getAll('bookmarks'), getAll('tags')]);
    const seed = bookmarks.find(b => b.id === 'bm:${TOKEN}');
    return JSON.stringify({
      count: bookmarks.length,
      seedExists: seed !== undefined,
      seedTagIds: seed ? [...seed.tags].sort() : null,
      mine: tags.filter(t => t.id.includes('zqtag'))
        .map(t => ({ id: t.id, name: t.name, color: t.color }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  })()`));

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

const clickRow = (index) => s.evaluate(`(() => {
  const row = document.querySelectorAll('.row')[${index}];
  if (!row) return 'NO ROW';
  row.click(); return true;
})()`);

const clickSelector = (selector) => s.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'NOT FOUND';
  el.click(); return true;
})()`);

/** Type into the detail pane's add-tag box and take the Create option. */
const createTag = async (name) => {
  await s.evaluate(`(() => {
    const input = document.querySelector('.detail__tag-input');
    if (!input) return 'NO INPUT';
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(300);
  return s.evaluate(`(() => {
    const b = [...document.querySelectorAll('.detail .btn')]
      .find(x => x.textContent.startsWith('Create'));
    if (!b) return 'NO CREATE BUTTON';
    b.click(); return true;
  })()`);
};

/** Commit a rename the way blurring the field does. */
const rename = (value) => s.evaluate(`(() => {
  const input = document.querySelector('.tag-editor__name');
  if (!input) return 'NO NAME FIELD';
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

/** What the tag view and its editor are showing. */
const shown = async () => JSON.parse(await s.evaluate(`JSON.stringify({
  rows: [...document.querySelectorAll('.row--tag')].map(r => ({
    title: r.querySelector('.row__title')?.textContent ?? '',
    meta: r.querySelector('.row__meta')?.textContent ?? '',
    unused: r.getAttribute('data-unused'),
  })),
  editorName: document.querySelector('.tag-editor__name')?.value ?? null,
  error: document.querySelector('.field__error')?.textContent ?? null,
  deleteLabel: document.querySelector('.tag-editor__delete')?.textContent ?? null,
  chips: [...document.querySelectorAll('.chip')].map(c => c.textContent),
})`));

const checks = [];
const check = (label, pass) => checks.push([label, pass]);

// ── create two tags from the record's detail pane ──────────────────────────────
await view('Library');
await search(TOKEN);
await wait(400);
await clickRow(0);
await wait(300);

await createTag(ALPHA);
await wait(600);
await createTag(BETA);
await wait(600);

const created = await stored();
check('both tags exist in IndexedDB',
  created.mine.map((t) => t.name).join('|') === `${ALPHA}|${BETA}`);
check('the record carries both, by id',
  created.seedTagIds?.join('|') === `tag:${ALPHA}|tag:${BETA}`);

// Typing a name that already resolves to an attached tag must not mint a second one.
await s.evaluate(`(() => {
  const input = document.querySelector('.detail__tag-input');
  input.value = ${JSON.stringify(ALPHA.toUpperCase())};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await wait(300);
const dup = await shown();
check('an already-attached tag offers no Create', dup.error === null);
check('and says why the input looks inert',
  (await s.evaluate('document.querySelector(".detail .field__hint")?.textContent ?? ""'))
    .includes('Already on this link'));

// ── detach one, leaving a tag on zero records ─────────────────────────────────
await s.evaluate(`(() => {
  const input = document.querySelector('.detail__tag-input');
  input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await clickSelector(`.chip__remove[aria-label="Remove ${BETA}"]`);
await wait(600);

const detached = await stored();
check('the tag came off the record', detached.seedTagIds?.join('|') === `tag:${ALPHA}`);
check('but the tag record survives', detached.mine.length === 2);

// ── the tag view shows it anyway — the sidebar would not ──────────────────────
await view('Tags');
await search('zqtag');
await wait(500);

const inTagView = await shown();
check('both tags are listed', inTagView.rows.length === 2);
check('the zero-record tag is shown, not hidden',
  inTagView.rows.some((r) => r.title === BETA && r.unused === 'true'));
check('and is labelled as unused', inTagView.rows.some((r) => r.meta.includes('unused')));

// ── rename: refused on a collision ────────────────────────────────────────────
const alphaRow = inTagView.rows.findIndex((r) => r.title === ALPHA);
await clickRow(alphaRow);
await wait(300);

await rename(BETA);
await wait(500);

const collided = await stored();
check('a colliding rename is refused',
  collided.mine.find((t) => t.id === `tag:${ALPHA}`)?.name === ALPHA);
check('and says which tag it collided with',
  ((await shown()).error ?? '').includes(BETA));

// ── rename: succeeds, and writes no bookmark record ───────────────────────────
const beforeRename = await stored();
await rename(GAMMA);
await wait(600);

const renamed = await stored();
check('the tag name changed',
  renamed.mine.find((t) => t.id === `tag:${ALPHA}`)?.name === GAMMA);
check('the record was not rewritten — it still holds the original id',
  renamed.seedTagIds?.join('|') === beforeRename.seedTagIds?.join('|'));
check('no link was added or lost', renamed.count === beforeRename.count);

// ── recolour ──────────────────────────────────────────────────────────────────
await clickSelector('.swatch[data-color="teal"]');
await wait(500);
check('the colour changed',
  (await stored()).mine.find((t) => t.id === `tag:${ALPHA}`)?.color === 'teal');
// `returnByValue` hands back a real number here, not a string.
check('amber is not offered — it is reserved for open-in-a-tab',
  Number(await s.evaluate('document.querySelectorAll(\'.swatch[data-color="amber"]\').length')) === 0);
check('the other nine colours are',
  Number(await s.evaluate('document.querySelectorAll(".swatch").length')) === 9);

// ── delete: two clicks, and no link goes with it ──────────────────────────────
const beforeDelete = await stored();
await clickSelector('.tag-editor__delete');
await wait(300);

const primed = await shown();
check('the first click primes and states the cost',
  (primed.deleteLabel ?? '').includes('Click again'));
check('the count on the button is the records it would touch',
  (primed.deleteLabel ?? '').includes('1 link'));
check('nothing is deleted yet', (await stored()).mine.length === beforeDelete.mine.length);

await clickSelector('.tag-editor__delete');
await wait(800);

const deleted = await stored();
check('the tag is gone from IndexedDB',
  deleted.mine.find((t) => t.id === `tag:${ALPHA}`) === undefined);
check('the link survives', deleted.seedExists && deleted.count === beforeDelete.count);
check('and no longer carries the tag', deleted.seedTagIds?.length === 0);

// A delete that only removed it from the Solid store would come back.
await s.evaluate('location.reload()');
await wait(2500);
const afterReload = await stored();
check('still gone after a reload',
  afterReload.mine.find((t) => t.id === `tag:${ALPHA}`) === undefined);
check('the other tag was not taken with it',
  afterReload.mine.find((t) => t.id === `tag:${BETA}`)?.name === BETA);

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
