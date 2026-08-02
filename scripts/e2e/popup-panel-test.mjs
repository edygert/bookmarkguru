/**
 * Verifies the popup save flow and the side-panel composition.
 *
 * Ordering matters: opening popup.html as a tab would make IT the active tab, so the
 * popup would try to save itself. The target tab is activated first, then the popup
 * is reloaded so its onMount sees the right tab.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session, wait, READ_DB, EXT_ID, PORT } from './cdp.mjs';

const DIR = join(tmpdir(), 'bookmarkguru-e2e', 'pages');
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'save-me.html'), '<title>A Page Worth Keeping</title><h1>hi</h1>');
const TARGET = `file://${join(DIR, 'save-me.html')}`;

// ── popup: first save ─────────────────────────────────────────────────────────
const popup = await session(PORT, EXT_ID, 'src/ui/popup.html');
const tabId = await popup.evaluate(
  `chrome.tabs.create({ url: ${JSON.stringify(TARGET)}, active: true }).then(t => t.id)`);
await wait(1500);
await popup.evaluate('location.reload()');
await wait(2500);

const title = await popup.evaluate(`document.getElementById('title')?.value ?? '(missing)'`);
const buttonsBefore = await popup.evaluate(
  `[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).join(' | ')`);

// Which page is about to be saved. The Title field is editable and may already have been
// changed, so the icon and domain are what identify it.
const page = JSON.parse(await popup.evaluate(`JSON.stringify({
  favicon: !!document.querySelector('.popup__page .favicon'),
  domain: document.querySelector('.popup__domain')?.textContent ?? null,
})`));
console.log('=== POPUP ===');
console.log('  title auto-filled :', title);
console.log('  buttons           :', buttonsBefore);

await popup.evaluate(`(() => {
  const el = document.getElementById('tags');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, 'Reading, Rust');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(300);
await popup.evaluate(
  `[...document.querySelectorAll('button')].find(b=>/^(Save|Update)$/.test(b.textContent.trim()))?.click()`);
await wait(2000);

// Read from a stable page — the popup closes itself after saving.
const reader = await session(PORT, EXT_ID, 'src/ui/manager.html');
const data = JSON.parse(await reader.evaluate(READ_DB));
// Identified by the title the popup auto-filled from the tab; a hand-saved record carries
// no import provenance to find it by.
const saved = data.items.find((i) => i.title === 'A Page Worth Keeping');
console.log('  stored            :', JSON.stringify(saved));

// ── popup: duplicate detection ────────────────────────────────────────────────
await reader.evaluate(`chrome.tabs.update(${tabId}, { active: true })`);
await wait(800);
const popup2 = await session(PORT, EXT_ID, 'src/ui/popup.html');
await popup2.evaluate(`chrome.tabs.update(${tabId}, { active: true })`);
await popup2.evaluate('location.reload()');
await wait(2500);
const dupShown = await popup2.evaluate(`document.body.textContent.includes('Already saved')`);
const buttonsAfter = await popup2.evaluate(
  `[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).join(' | ')`);
console.log('  already-saved     :', dupShown);
console.log('  buttons on revisit:', buttonsAfter);

// ── side panel ────────────────────────────────────────────────────────────────
const panel = await session(PORT, EXT_ID, 'src/ui/panel.html');
await wait(1500);
const layout = await panel.evaluate(`document.querySelector('.app')?.dataset.layout`);
const hasSidebar = await panel.evaluate(`!!document.querySelector('.sidebar')`);
const hasDetail = await panel.evaluate(`!!document.querySelector('.detail')`);
const hasSearch = await panel.evaluate(`!!document.querySelector('.search')`);
console.log('\n=== SIDE PANEL ===');
console.log('  layout            :', layout);
console.log('  sidebar / detail  :', hasSidebar, '/', hasDetail, '(both expected false)');
console.log('  search            :', hasSearch);
console.log('  rows              :', await panel.evaluate(`document.querySelectorAll('.row').length`));
console.log('  sidePanel API     :', await panel.evaluate(`typeof chrome.sidePanel?.open`));

const checks = [
  ['popup auto-fills the tab title', title === 'A Page Worth Keeping'],
  ['popup offers Save for a new URL', buttonsBefore.includes('Save')],
  ['comma-separated tags parsed', JSON.stringify(saved?.tags) === JSON.stringify(['Reading', 'Rust'])],
  ['a hand-saved link lands in the library, not the inbox', saved?.status === 'active'],
  ['hostless URL gets a groupable domain', saved?.domain === 'file://'],
  ['popup shows the page it is about to save', page.favicon && page.domain === 'file://'],
  ['revisit detects "Already saved"', dupShown === true],
  ['revisit offers Update, not Save', buttonsAfter.includes('Update')],
  ['panel renders compact', layout === 'compact'],
  ['panel drops sidebar and detail', !hasSidebar && !hasDetail],
  ['panel keeps search', hasSearch],
];

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
const errs = [...popup.errors, ...popup2.errors, ...reader.errors, ...panel.errors];
console.log('\nerrors:', errs.length ? errs.join('\n') : '(none)');
process.exit(ok && !errs.length ? 0 : 1);
