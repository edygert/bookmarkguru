/**
 * Seeds a nested Chrome bookmark tree, imports it, and checks the conversion.
 *
 * The assertions encode the product's central claim: a single-parent folder tree
 * becomes many-to-many tags, and a URL filed in two places becomes ONE record
 * carrying both tags — something the tree itself cannot express.
 */
import { session, wait, READ_DB, EXT_ID, PORT } from './cdp.mjs';

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');

console.log('seeding Chrome bookmarks…');
await s.evaluate(`(async () => {
  const bar = '1';
  const dev   = await chrome.bookmarks.create({ parentId: bar, title: 'Dev' });
  const tools = await chrome.bookmarks.create({ parentId: dev.id, title: 'Tools' });
  const read  = await chrome.bookmarks.create({ parentId: bar, title: 'Reading' });
  await chrome.bookmarks.create({ parentId: tools.id, title: 'ripgrep', url: 'https://github.com/BurntSushi/ripgrep' });
  await chrome.bookmarks.create({ parentId: tools.id, title: 'fd', url: 'https://github.com/sharkdp/fd' });
  await chrome.bookmarks.create({ parentId: read.id, title: 'Rust Book', url: 'https://doc.rust-lang.org/book/' });
  await chrome.bookmarks.create({ parentId: read.id, title: 'ripgrep', url: 'https://github.com/BurntSushi/ripgrep' }); // dup
  await chrome.bookmarks.create({ parentId: bar, title: 'Extensions', url: 'chrome://extensions' });   // must skip
  return true;
})()`);

await s.evaluate('location.reload()');
await wait(2500);
console.log('import:', await s.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Import from Chrome'));
  if (!b) return 'BUTTON NOT FOUND (library may already be populated)';
  b.click(); return 'clicked';
})()`));
await wait(3000);

const data = JSON.parse(await s.evaluate(READ_DB));
console.log('\n=== STORED ===');
console.log(JSON.stringify(data, null, 2));

const ripgrep = data.items.find((i) => i.title === 'ripgrep');
const checks = [
  ['3 bookmarks stored (dup collapsed, chrome:// skipped)', data.count === 3],
  ['folders became tags', ['Dev', 'Reading', 'Tools'].every((t) => data.tags.includes(t))],
  ['synthetic root "Bookmarks bar" is NOT a tag', !data.tags.includes('Bookmarks bar')],
  ['URL filed twice kept ONE record with union of tags',
    ripgrep && ['Dev', 'Reading', 'Tools'].every((t) => ripgrep.tags.includes(t))],
  ['original folder path preserved', !!ripgrep?.folder],
  ['rows rendered', (await s.evaluate(`document.querySelectorAll('.row').length`)) === 3],
];

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
console.log('\nerrors:', s.errors.length ? s.errors.join('\n') : '(none)');
process.exit(ok && !s.errors.length ? 0 : 1);
