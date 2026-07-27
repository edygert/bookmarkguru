/**
 * The Phase 1 exit criterion: activating a bookmark must focus an EXISTING tab
 * rather than opening a duplicate.
 *
 * Uses file:// URLs so it needs no network and is fully deterministic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session, wait, EXT_ID, PORT } from './cdp.mjs';

const DIR = join(tmpdir(), 'bookmarkguru-e2e', 'pages');
mkdirSync(DIR, { recursive: true });
for (const n of [1, 2]) writeFileSync(join(DIR, `p${n}.html`), `<title>Page ${n}</title><h1>Page ${n}</h1>`);
const URL_A = `file://${join(DIR, 'p1.html')}`;
const URL_B = `file://${join(DIR, 'p2.html')}`;

const s = await session(PORT, EXT_ID, 'src/ui/manager.html');
const tabs = async () => JSON.parse(await s.evaluate(
  `chrome.tabs.query({}).then(t => JSON.stringify({ count: t.length, active: t.filter(x=>x.active).map(x=>x.url) }))`));

// 1. open URL_A for real
await s.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(URL_A)}, active: false })`);
await wait(1500);
const before = await tabs();
console.log('before        :', before);

// 2. same URL — must switch, not duplicate
const sw = await s.evaluate(`chrome.runtime.sendMessage({ kind: 'open-or-switch', url: ${JSON.stringify(URL_A)} })`);
await wait(1500);
const afterSwitch = await tabs();
console.log('switch result :', sw);
console.log('after switch  :', afterSwitch);

// 3. unopened URL — must create
const cr = await s.evaluate(`chrome.runtime.sendMessage({ kind: 'open-or-switch', url: ${JSON.stringify(URL_B)} })`);
await wait(1500);
const afterCreate = await tabs();
console.log('create result :', cr);
console.log('after create  :', afterCreate);

const checks = [
  ['existing tab focused, no duplicate', sw?.switched === true && afterSwitch.count === before.count],
  ['matched tab became active', afterSwitch.active.some((u) => u.includes('p1.html'))],
  ['new tab opened when nothing matched', cr?.switched === false && afterCreate.count === before.count + 1],
];

console.log('\n=== VERDICT ===');
let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? '✓' : '✗'} ${label}`); ok &&= pass; }
if (sw === '<<TIMEOUT>>') console.log('\n!! sendMessage hung — the service worker is probably not registered.');
process.exit(ok ? 0 : 1);
