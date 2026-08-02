/**
 * Importing exported bookmark files from the sidebar.
 *
 * `import-test.mjs` already covers the pipeline every import shares — folder tagging,
 * qualification, status routing — over the live Chrome tree. This one covers what is
 * different about a file: the picker, the handoff into that same pipeline, and what
 * happens when the same file is imported twice.
 *
 * Two claims here cannot be seen from the DOM and are read back out of IndexedDB:
 *
 *   1. **A re-import adds nothing.** The list looks identical whether the second import
 *      wrote 3 duplicate records or 0, and the record count is the only thing that says
 *      which.
 *   2. **A file with no bookmarks in it writes nothing.** The failure and the empty
 *      success used to be the same all-zero summary, so the note alone is not proof.
 *
 * The file input is filled through a `DataTransfer` rather than by clicking its label,
 * which would open an OS file dialog. The `change` handler, `file.text()` and the Import
 * click all run for real.
 *
 * Runs after `triage-test` — it adds records, so it must not disturb the scripts with
 * fixed expectations — and before `backup-test`, which replaces the whole library.
 */
import { session, wait, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

/** A domain nothing else in the library can match. */
const DOMAIN = 'zqfile.example';

const checks = [];
const check = (label, pass) => checks.push([label, pass]);

/** A minimal Netscape export: one folder per group, one <A> per link. */
const exportFile = (folders) => {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<DL><p>',
    '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
    '    <DL><p>',
  ];
  for (const [folder, slugs] of Object.entries(folders)) {
    lines.push(`        <DT><H3 ADD_DATE="1700000000">${folder}</H3>`, '        <DL><p>');
    for (const slug of slugs) {
      lines.push(
        `            <DT><A HREF="https://${DOMAIN}/${slug}" ADD_DATE="1700000000">${slug} page</A>`,
      );
    }
    lines.push('        </DL><p>');
  }
  lines.push('    </DL><p>', '</DL><p>');
  return lines.join('\n');
};

/** Records this script put in the library, and the tags they carry. */
const state = () => s.evaluate(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('bookmarkguru');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const getAll = (store) => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const [bookmarks, tags] = await Promise.all([getAll('bookmarks'), getAll('tags')]);
  const name = Object.fromEntries(tags.map(t => [t.id, t.name]));
  const mine = bookmarks.filter(b => b.domain === '${DOMAIN}');
  return JSON.stringify({
    total: bookmarks.length,
    mine: mine.length,
    slugs: mine.map(b => b.url.split('/').pop()).sort(),
    tags: [...new Set(mine.flatMap(b => b.tags.map(i => name[i])))].sort(),
    ids: mine.map(b => b.id).sort(),
  });
})()`);

/**
 * Fill the picker the way a file dialog would.
 *
 * `files` is an array of [name, contents]; more than one exercises the `multiple`
 * attribute and the loop behind it.
 */
const pick = (files) => s.evaluate(`(() => {
  const input = document.querySelector('#import-file');
  if (!input) return 'NO IMPORT INPUT';
  const dt = new DataTransfer();
  for (const [name, text] of ${JSON.stringify(files)}) {
    dt.items.add(new File([text], name, { type: 'text/html' }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'picked';
})()`);

const importLabel = () => s.evaluate(
  `document.querySelector('.sidebar__group--import .sidebar__file-label')?.textContent ?? null`,
);

const importNote = () => s.evaluate(`(() => {
  const notes = document.querySelectorAll('.sidebar__group--import .sidebar__note');
  const last = notes[notes.length - 1];
  return last ? JSON.stringify({ text: last.textContent, error: last.dataset.error ?? null }) : null;
})()`);

/**
 * Click Import and watch for the progress bar while the write runs.
 *
 * A MutationObserver rather than polling: the element can come and go inside one frame on
 * a small import, and a poll that misses it would report a missing progress bar as a
 * failure of the feature rather than of the test.
 */
const runImport = () => s.evaluate(`(async () => {
  const button = document.querySelector('.sidebar__import');
  if (!button) return 'NO IMPORT BUTTON';

  const seen = [];
  const observer = new MutationObserver(() => {
    const bar = document.querySelector('.sidebar__progress');
    if (bar) seen.push({ value: Number(bar.value), max: Number(bar.max) });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });

  button.click();
  // Gone once the import finishes: the button only renders while files are chosen.
  for (let i = 0; i < 120 && document.querySelector('.sidebar__import'); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  observer.disconnect();
  return JSON.stringify({
    sawBar: seen.length > 0,
    reachedMax: seen.some(p => p.max > 0 && p.value === p.max),
    barStillThere: document.querySelector('.sidebar__progress') !== null,
  });
})()`);

// ── one file ──────────────────────────────────────────────────────────────────

const FILE_ONE = exportFile({ ZqAlpha: ['one', 'two'], ZqBeta: ['three'] });

const before = JSON.parse(await state());
check('the library has no records from this script yet', before.mine === 0);

console.log('picking one file…');
console.log('pick:', await pick([['zq-export-one.html', FILE_ONE]]));
await wait(300);

check('the label names the chosen file', (await importLabel()) === 'zq-export-one.html');

const firstRun = JSON.parse(await runImport());
await wait(500);
const afterOne = JSON.parse(await state());

check('the file landed as records', afterOne.mine === 3);
check('every link in the file is there', JSON.stringify(afterOne.slugs) ===
  JSON.stringify(['one', 'three', 'two']));
check('folders became tags', afterOne.tags.includes('ZqAlpha') && afterOne.tags.includes('ZqBeta'));
check('a progress bar was shown while writing', firstRun.sawBar);
check('it reached its own maximum', firstRun.reachedMax);
check('and it is gone once the import finishes', firstRun.barStillThere === false);

const firstNote = JSON.parse(await importNote());
check('the summary reports what was added', /^Added 3 · /.test(firstNote.text));
check('and does not report it as an error', firstNote.error !== 'true');

// ── the same file again ───────────────────────────────────────────────────────

console.log('importing the very same file again…');
await pick([['zq-export-one.html', FILE_ONE]]);
await wait(300);
await runImport();
await wait(500);

const afterRepeat = JSON.parse(await state());
check('a re-import adds no records', afterRepeat.mine === 3);
check('and does not replace the ones already there',
  JSON.stringify(afterRepeat.ids) === JSON.stringify(afterOne.ids));

const repeatNote = JSON.parse(await importNote());
check('it says nothing was new', /^Nothing new — all 3 links were already saved\.$/.test(repeatNote.text));

// ── a second file that overlaps the first ─────────────────────────────────────

const FILE_TWO = exportFile({ ZqAlpha: ['two'], ZqGamma: ['four'] });

console.log('importing a second file sharing one URL…');
await pick([['zq-export-two.html', FILE_TWO]]);
await wait(300);
await runImport();
await wait(500);

const afterTwo = JSON.parse(await state());
check('only the new URL was added', afterTwo.mine === 4);
check('the overlapping URL was not duplicated',
  afterTwo.slugs.filter(slug => slug === 'two').length === 1);
check('the new file\'s folder became a tag', afterTwo.tags.includes('ZqGamma'));

const twoNote = JSON.parse(await importNote());
check('the summary counts one added and one already saved', /^Added 1 · 1 already saved/.test(twoNote.text));

// ── two files at once ─────────────────────────────────────────────────────────

console.log('importing two files in one pick…');
await pick([
  ['zq-export-three.html', exportFile({ ZqAlpha: ['five'] })],
  ['zq-export-four.html', exportFile({ ZqAlpha: ['six'] })],
]);
await wait(300);
check('the label counts the files rather than naming one', (await importLabel()) === '2 files');

await runImport();
await wait(600);

const afterBoth = JSON.parse(await state());
check('both files were imported', afterBoth.mine === 6);
check('each contributed its own link',
  afterBoth.slugs.includes('five') && afterBoth.slugs.includes('six'));

const bothNote = JSON.parse(await importNote());
check('the summary is the total across both files', /^Added 2 · /.test(bothNote.text));

// ── a file that is not a bookmark export ──────────────────────────────────────

console.log('feeding it a JSON file…');
await pick([['not-an-export.json', '{"hello":"world"}']]);
await wait(300);
await runImport();
await wait(500);

const afterJunk = JSON.parse(await state());
check('a file with no bookmarks writes nothing', afterJunk.mine === 6);
check('and leaves the rest of the library alone', afterJunk.total === afterBoth.total);

const junkNote = JSON.parse(await importNote());
check('it says the file held no bookmarks',
  junkNote.text === 'No bookmarks in that file. Is it a browser export?');
check('and says it as an error', junkNote.error === 'true');

// A summary of all zeros used to be what a *crash* returned too.
check('an empty file is not reported as a failure', !/failed|error/i.test(junkNote.text));

// ── the records survive a reload ──────────────────────────────────────────────

await s.evaluate('location.reload()');
await wait(2500);
const afterReload = JSON.parse(await state());
check('everything imported is still there after a reload', afterReload.mine === 6);

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
