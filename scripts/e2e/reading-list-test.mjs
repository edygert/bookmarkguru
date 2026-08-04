/**
 * Seeds the browser's reading list, imports it, and checks what landed.
 *
 * The claims are the two this source makes that no other does: every item carries the
 * stated `Reading List` tag, and every item lands in the inbox rather than the library.
 *
 * Runs second, so the library already holds import-test's records. Expectations are
 * therefore deltas computed from live state, never absolute totals.
 *
 * It skips rather than fails when the browser has no reading list. `launch.sh` runs
 * Brave by default, which ships no reading-list UI, and a browser that cannot hold the
 * data cannot be asked to prove anything about it.
 */
import { session, wait, READ_DB, EXT_ID, PORT } from './cdp.mjs';

const ITEMS = [1, 2, 3].map((n) => ({
  // Distinct from every other script's URLs, so no later count can collide with these.
  url: `https://readinglist-${n}.example.com/`,
  title: `Reading List Item ${n}`,
}));

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

if ((await s.evaluate('typeof chrome.readingList')) === 'undefined') {
  console.log('⊘ skipped: this browser exposes no chrome.readingList');
  process.exit(0);
}

const before = JSON.parse(await s.evaluate(READ_DB)).count;

console.log('seeding the reading list…');
const seeded = await s.evaluate(`(async () => {
  try {
    for (const e of ${JSON.stringify(ITEMS)}) {
      await chrome.readingList.addEntry({ ...e, hasBeenRead: false });
    }
  } catch (err) {
    return 'ERROR: ' + err.message;
  }
  return (await chrome.readingList.query({})).length;
})()`);
console.log('entries in the reading list:', seeded);

if (seeded !== ITEMS.length) {
  console.log(`⊘ skipped: this browser would not hold the seeded entries (${seeded})`);
  process.exit(0);
}

await s.evaluate('location.reload()');
await wait(2500);
console.log('import:', await s.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Import reading list'));
  if (!b) return 'BUTTON NOT FOUND';
  b.click(); return 'clicked';
})()`));
await wait(3000);

const data = JSON.parse(await s.evaluate(READ_DB));
const imported = data.items.filter((i) => i.title.startsWith('Reading List Item'));

console.log('\n=== IMPORTED ===');
console.log(JSON.stringify(imported, null, 2));

const checks = [
  ['every seeded entry became a record', imported.length === ITEMS.length],
  ['nothing else was written', data.count === before + ITEMS.length],
  ['"Reading List" is a tag', data.tags.includes('Reading List')],
  ['every record carries it', imported.every((i) => i.tags.includes('Reading List'))],
  ['every record landed in the inbox', imported.every((i) => i.status === 'inbox')],
  ['no folder path — the source has no tree', imported.every((i) => !i.folder)],
];

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
