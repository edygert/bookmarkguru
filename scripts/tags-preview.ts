/**
 * Read-only preview of what an import would produce.
 *
 *     npm run tags:preview -- ~/bookmarks.html
 *
 * Writes nothing, touches no database. The point is to tune the noise rules in
 * `core/io/folder-tags.ts` against a real export *before* committing thousands of records
 * to IndexedDB — the rules were derived from one specific library, and the only honest
 * way to check them is to run them over the real thing and read the output.
 *
 * It imports the real rules rather than reimplementing them. If this file ever grows its
 * own copy of a pattern, the preview stops predicting the import, which defeats it.
 */
import { readFileSync } from 'node:fs';
import { classifyFolder, type FolderClass, type FolderRules } from '~/core/io/folder-tags';
import { htmlToEntries } from '~/core/io/html-import';
import { ingest } from '~/core/io/ingest';

const path = process.argv[2];
if (!path) {
  console.error('usage: npm run tags:preview -- <bookmarks.html>');
  process.exit(1);
}

// The same file the extension bundles, read here rather than imported, so tuning a rule
// takes effect on the next run with no rebuild. One source of truth for both paths.
const rulesPath = new URL('../config/folder-rules.json', import.meta.url);
let rules: FolderRules = {};
try {
  rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as FolderRules;
} catch {
  console.error('! config/folder-rules.json not found — run `npm run config`. Using generic rules only.\n');
}

const entries = htmlToEntries(readFileSync(path, 'utf8'));
const result = ingest(entries, { kind: 'html-import', now: Date.now(), rules });

const pct = (n: number, of: number) => (of === 0 ? '0' : ((n / of) * 100).toFixed(1));
const pad = (n: number, w = 5) => String(n).padStart(w);
const rule = (label: string) => `\n\x1b[1m${label}\x1b[0m\n`;

// ── headline ──────────────────────────────────────────────────────────────────

const tagged = result.bookmarks.filter((b) => b.tags.length > 0).length;

console.log(rule('SUMMARY'));
console.log(`  ${pad(entries.length)}  entries parsed`);
console.log(`  ${pad(result.bookmarks.length)}  records after dedupe`);
console.log(`  ${pad(result.summary.alreadySaved)}  duplicates collapsed (tags unioned)`);
console.log(`  ${pad(result.summary.skipped)}  skipped as uningestable`);
console.log(`  ${pad(result.summary.inboxed)}  routed to inbox (saved tab sets)`);
console.log(`  ${pad(result.tags.length)}  tags`);
console.log(
  `  ${pad(tagged)}  records with >=1 tag  (${pct(tagged, result.bookmarks.length)}%)`,
);

// ── tags by frequency ─────────────────────────────────────────────────────────

const counts = new Map<string, number>();
for (const b of result.bookmarks) {
  for (const id of b.tags) counts.set(id, (counts.get(id) ?? 0) + 1);
}
const byId = new Map(result.tags.map((t) => [t.id, t]));

/** How a tag reads in this report: qualified ones show the parent they were kept under. */
function label(id: string): string {
  const tag = byId.get(id);
  if (!tag) return id;
  if (tag.parent === undefined) return tag.name;
  return `${byId.get(tag.parent)?.name ?? tag.parent} · ${tag.name}`;
}

// An array, not an object — integer-like keys ('1') sort ahead of the rest in objects,
// which silently reverses the intended order.
const buckets: [string, (n: number) => boolean, number][] = [
  ['200+', (n) => n >= 200, 0],
  ['50-199', (n) => n >= 50 && n < 200, 0],
  ['10-49', (n) => n >= 10 && n < 50, 0],
  ['5-9', (n) => n >= 5 && n < 10, 0],
  ['2-4', (n) => n >= 2 && n < 5, 0],
  ['1', (n) => n === 1, 0],
];
for (const c of counts.values()) {
  for (const bucket of buckets) if (bucket[1](c)) bucket[2]++;
}
console.log(rule('TAG FREQUENCY  (mass in 10-49 is what makes tags worth clicking)'));
for (const [name, , n] of buckets) {
  console.log(`  ${name.padEnd(8)} ${pad(n, 4)} tags`);
}

console.log(rule('TOP 30 TAGS'));
for (const [id, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`  ${pad(count)}  ${label(id)}`);
}

// ── qualified tags: the whole point ───────────────────────────────────────────

const qualified = result.tags.filter((t) => t.parent !== undefined);
const groups = new Map<string, { name: string; count: number }[]>();
for (const tag of qualified) {
  const general = tag.id.slice(tag.id.lastIndexOf('/') + 1);
  const key = `tag:${general}`;
  const list = groups.get(key) ?? [];
  list.push({ name: byId.get(tag.parent!)?.name ?? tag.parent!, count: counts.get(tag.id) ?? 0 });
  groups.set(key, list);
}

console.log(rule(`QUALIFIED — kept separate instead of merged (${groups.size} names)`));
if (groups.size === 0) {
  console.log('  none — no folder name appeared under two different parents');
}
for (const [generalId, parents] of groups) {
  const general = byId.get(generalId);
  console.log(
    `  ${(general?.name ?? generalId).padEnd(24)} ${pad(counts.get(generalId) ?? 0)} total`,
  );
  for (const p of parents.sort((a, b) => b.count - a.count)) {
    console.log(`      └ ${p.name.padEnd(20)} ${pad(p.count)}`);
  }
}

// ── what got dropped, and why ─────────────────────────────────────────────────

const dropped = new Map<string, { cls: FolderClass; count: number }>();
for (const e of entries) {
  for (const name of e.folderPath) {
    const cls = classifyFolder(name, rules);
    if (cls === 'keep') continue;
    const seen = dropped.get(name) ?? { cls, count: 0 };
    seen.count++;
    dropped.set(name, seen);
  }
}

console.log(rule('DROPPED AS NOISE  (folder name → bookmarks beneath it)'));
for (const [name, { cls, count }] of [...dropped].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${pad(count)}  ${name.padEnd(32)} ${cls}`);
}

// ── records that end up with nothing ──────────────────────────────────────────

const untagged = result.bookmarks.filter((b) => b.tags.length === 0);
const untaggedActive = untagged.filter((b) => b.status !== 'inbox');
console.log(rule('UNTAGGED'));
console.log(`  ${pad(untagged.length)}  total, of which ${untaggedActive.length} are NOT inbox`);
console.log('  A large non-inbox number here means a noise rule is too aggressive.');
for (const b of untaggedActive.slice(0, 15)) {
  console.log(`      [${b.source.originalFolderPath ?? '(root)'}] ${b.title.slice(0, 52)}`);
}
