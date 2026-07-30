/**
 * JSON backup and restore.
 *
 * The claim being tested is fidelity, and it is not visible from the DOM. Every field a
 * backup exists to carry — the id, the note, the status, the open count, `Tag.parent` — is
 * either invisible on screen or renders identically whether or not it survived, so the
 * assertions read records **raw out of IndexedDB**. Deliberately not `READ_DB`, which
 * resolves tag ids to names and drops most fields: ids are the whole point here, since an
 * import would have minted new ones and looked fine.
 *
 * That is also how the store→IndexedDB proxy bug was caught twice before. Every DOM
 * assertion around it passed while nothing reached the database.
 *
 * Two harness interventions, both confined to this file:
 *
 *   1. `URL.createObjectURL` is wrapped to capture the Blob the export builds, and
 *      `HTMLAnchorElement.click` is stubbed so headless Chrome does not try to write a real
 *      download. The export path itself runs unmodified.
 *   2. The file input is filled through a `DataTransfer` rather than by clicking its label,
 *      which would open an OS file dialog. The `change` handler, `file.text()` and both
 *      confirm clicks all run for real.
 *
 * The backup text never leaves the page — a full library is megabytes, and shipping it
 * through the protocol to assert on it here would be slow for no gain.
 *
 * Runs **last**. It replaces the entire library, so every earlier script's expectations
 * would be computed against data this one has already thrown away.
 */
import { session, wait, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

/** Tokens nothing else in the library or its tags can match. */
const TOKEN = 'zqbackup';
const ID = `bm:${TOKEN}`;
const GENERAL = `tag:${TOKEN}gen`;
const QUALIFIED = `tag:${TOKEN}gen/${TOKEN}qual`;

const checks = [];
const check = (label, pass) => checks.push([label, pass]);

/** Open the database once per evaluate; there is no shared page state to lean on. */
const DB = `await new Promise((res, rej) => {
  const r = indexedDB.open('bookmarkguru');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
})`;

// ── seed one record with every field set to a non-default value ────────────────

console.log('seeding a record with a note, an archived status and two tags…');
const seeded = await s.evaluate(`(async () => {
  const db = ${DB};
  const tx = db.transaction(['bookmarks', 'tags'], 'readwrite');
  const url = 'https://backup.example/${TOKEN}';
  tx.objectStore('bookmarks').put({
    id: '${ID}',
    url, normalizedUrl: url, domain: 'backup.example',
    title: '${TOKEN} record', description: 'desc',
    notes: 'a note that only a backup can carry',
    tags: ['${GENERAL}', '${QUALIFIED}'],
    createdAt: 5000, updatedAt: 5001,
    lastOpenedAt: 5002, openCount: 7, favorite: true, pinned: true,
    status: 'archived',
    source: { kind: 'manual', importedAt: 5000 },
  });
  tx.objectStore('tags').put({ id: '${GENERAL}', name: '${TOKEN}GEN', color: 'slate' });
  tx.objectStore('tags').put({
    id: '${QUALIFIED}', name: '${TOKEN}QUAL', color: 'indigo', parent: '${GENERAL}',
  });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return 'seeded';
})()`);
console.log('seed:', seeded);

await s.evaluate('location.reload()');
await wait(2500);

// ── export ────────────────────────────────────────────────────────────────────

console.log('exporting…');
const exported = await s.evaluate(`(async () => {
  const realCreate = URL.createObjectURL;
  const realClick = HTMLAnchorElement.prototype.click;
  let captured = null;
  URL.createObjectURL = (blob) => { captured = blob; return realCreate.call(URL, blob); };
  HTMLAnchorElement.prototype.click = function () {};

  const button = document.querySelector('.sidebar__export');
  if (!button) return 'NO EXPORT BUTTON';
  const label = button.textContent;
  button.click();

  // The handler awaits the repository read before building the Blob.
  for (let i = 0; i < 40 && captured === null; i++) await new Promise(r => setTimeout(r, 50));
  URL.createObjectURL = realCreate;
  HTMLAnchorElement.prototype.click = realClick;
  if (captured === null) return 'NO BLOB';

  // Kept on the page; a full library is far too big to ship through the protocol.
  window.__backup = await captured.text();
  return JSON.stringify({ label, type: captured.type, bytes: window.__backup.length });
})()`);
console.log('export:', exported);

const exportInfo = JSON.parse(exported);
check('export button is labelled with a link count', /Export \d+ links?/.test(exportInfo.label));
check('the download is typed as JSON', exportInfo.type === 'application/json');

const inFile = JSON.parse(
  await s.evaluate(`(() => {
    const payload = JSON.parse(window.__backup);
    const record = payload.bookmarks.find(b => b.id === '${ID}');
    const qualified = payload.tags.find(t => t.id === '${QUALIFIED}');
    return JSON.stringify({
      format: payload.format,
      schemaVersion: payload.schemaVersion,
      hasExportedAt: typeof payload.exportedAt === 'number',
      keys: Object.keys(payload).sort(),
      record, qualified,
      total: payload.bookmarks.length,
    });
  })()`),
);

check('file declares itself a BookmarkGuru backup', inFile.format === 'bookmarkguru-backup');
check('file carries a schema version', inFile.schemaVersion === 1);
check('file carries an export timestamp', inFile.hasExportedAt);
check(
  'file carries only format, version, timestamp, bookmarks and tags',
  JSON.stringify(inFile.keys) ===
    JSON.stringify(['bookmarks', 'exportedAt', 'format', 'schemaVersion', 'tags']),
);
check('the note is in the file', inFile.record?.notes === 'a note that only a backup can carry');
check('the archived status is in the file', inFile.record?.status === 'archived');
check('the open count is in the file', inFile.record?.openCount === 7);
check('the qualified tag keeps its parent', inFile.qualified?.parent === GENERAL);

// ── delete the record, then restore it from the file ──────────────────────────
//
// Deleted rather than reloaded-after-a-wipe, because `window.__backup` must survive. The
// restore path wipes the database itself, so this only has to prove the record that comes
// back came from the file.

console.log('deleting the seeded record and its tags…');
const removed = await s.evaluate(`(async () => {
  const db = ${DB};
  const tx = db.transaction(['bookmarks', 'tags'], 'readwrite');
  tx.objectStore('bookmarks').delete('${ID}');
  tx.objectStore('tags').delete('${GENERAL}');
  tx.objectStore('tags').delete('${QUALIFIED}');
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const gone = await new Promise((res, rej) => {
    const r = db.transaction('bookmarks').objectStore('bookmarks').get('${ID}');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return gone === undefined ? 'gone' : 'still there';
})()`);
check('the record really was removed before restoring', removed === 'gone');

/** Fill the file input the way a picker would, without opening an OS dialog. */
const pick = (text, name) => s.evaluate(`(() => {
  const input = document.querySelector('.sidebar__file');
  if (!input) return 'NO FILE INPUT';
  const dt = new DataTransfer();
  dt.items.add(new File([${text}], ${JSON.stringify(name)}, { type: 'application/json' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'picked';
})()`);

const replaceButton = () => s.evaluate(`(() => {
  const b = document.querySelector('.sidebar__replace');
  return b === null ? null : b.textContent;
})()`);

const clickReplace = () => s.evaluate(`(() => {
  const b = document.querySelector('.sidebar__replace');
  if (!b) return 'NOT FOUND';
  b.click(); return 'clicked';
})()`);

check('no Replace button before a file is chosen', (await replaceButton()) === null);

console.log('choosing the backup file…');
console.log('pick:', await pick('window.__backup', 'bookmarkguru-test.json'));
await wait(300);

const primed = await replaceButton();
check('Replace appears once a file is chosen', primed !== null);
check('first click is not the destructive one', primed === 'Replace library');

await clickReplace();
await wait(300);
const armed = await replaceButton();
check(
  'second label names the number of links it destroys',
  /Click again — replaces \d+ links?/.test(armed ?? ''),
);

console.log('restoring…');
await clickReplace();
await wait(3000);

/** Raw records — ids and every field, with nothing resolved or dropped. */
const raw = () => s.evaluate(`(async () => {
  const db = ${DB};
  const getAll = (store) => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const [bookmarks, tags, meta] = await Promise.all([
    getAll('bookmarks'), getAll('tags'), getAll('meta'),
  ]);
  return JSON.stringify({
    total: bookmarks.length,
    record: bookmarks.find(b => b.id === '${ID}') ?? null,
    qualified: tags.find(t => t.id === '${QUALIFIED}') ?? null,
    tagCount: tags.length,
    firstRunComplete: meta.find(m => m.key === 'firstRunComplete')?.value ?? null,
  });
})()`);

const restored = JSON.parse(await raw());

check('the record is back in IndexedDB', restored.record !== null);
check('its id is the original, not a fresh one', restored.record?.id === ID);
check('the note survived', restored.record?.notes === 'a note that only a backup can carry');
check('the status survived', restored.record?.status === 'archived');
check('the open count survived', restored.record?.openCount === 7);
check('favorite survived', restored.record?.favorite === true);
check('lastOpenedAt survived', restored.record?.lastOpenedAt === 5002);
check('createdAt was not stamped with the restore time', restored.record?.createdAt === 5000);
check('the tag ids on the record survived', restored.record?.tags?.includes(QUALIFIED));
check('the qualified tag kept its parent', restored.qualified?.parent === GENERAL);
check('every record in the file came back', restored.total === inFile.total);

const message = await s.evaluate(
  `document.querySelector('.sidebar__note')?.textContent ?? null`,
);
check('the restore reports what it wrote', /Restored \d+ links?/.test(message ?? ''));

// A restore that only wrote to the Solid store would look identical until now.
await s.evaluate('location.reload()');
await wait(2500);
const afterReload = JSON.parse(await raw());
check('still there after a reload', afterReload.record?.id === ID);

// `clearAll` wipes `meta` along with everything else, so a restore that did not re-set this
// would come back showing the first-run empty state over a full library. The record count
// cannot catch that — the marker is what the empty state actually reads.
check('the first-run marker was re-set after the wipe', afterReload.firstRunComplete === true);

// ── a file that is not a backup must change nothing ───────────────────────────

console.log('feeding it a foreign JSON file…');
await pick(JSON.stringify('{"hello":"world"}'), 'not-a-backup.json');
await wait(300);
await clickReplace();
await wait(300);
await clickReplace();
await wait(1500);

const afterForeign = JSON.parse(await raw());
check('a foreign file leaves the library alone', afterForeign.total === afterReload.total);
check('and leaves the seeded record alone', afterForeign.record?.id === ID);

const rejection = JSON.parse(
  await s.evaluate(`(() => {
    const note = document.querySelector('.sidebar__note');
    return JSON.stringify({ text: note?.textContent ?? null, error: note?.dataset.error ?? null });
  })()`),
);
check('it says the file is not a backup', rejection.text === 'Not a BookmarkGuru backup.');
check('and says it as an error', rejection.error === 'true');

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
