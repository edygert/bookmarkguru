#!/usr/bin/env node
/**
 * Manifest permission guard.
 *
 * Catches a failure mode nothing else in the check suite can see: using a chrome.*
 * namespace without declaring its permission. TypeScript happily accepts
 * `chrome.contextMenus.create(...)` because @types/chrome declares the whole API
 * surface regardless of what the manifest asks for. At runtime the namespace is
 * `undefined`, so `.addListener` throws during module evaluation and the **service
 * worker silently fails to register** — no console error, no failed build, the
 * extension just quietly does nothing.
 *
 * This is exactly how the contextMenus bug shipped, and it cost a long bisect to find.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const MANIFEST = new URL('../manifest.config.ts', import.meta.url).pathname;

/**
 * Namespaces that require a permission entry. Anything absent from this map either
 * needs no permission (runtime, i18n, action, windows, extension) or is not worth
 * guessing about — unknown namespaces are ignored so the guard never cries wolf.
 */
const REQUIRES = {
  alarms: 'alarms',
  bookmarks: 'bookmarks',
  contextMenus: 'contextMenus',
  cookies: 'cookies',
  downloads: 'downloads',
  history: 'history',
  idle: 'idle',
  management: 'management',
  notifications: 'notifications',
  scripting: 'scripting',
  sidePanel: 'sidePanel',
  storage: 'storage',
  tabGroups: 'tabGroups',
  tabs: 'tabs',
  topSites: 'topSites',
  webNavigation: 'webNavigation',
  webRequest: 'webRequest',
};

const manifestText = await readFile(MANIFEST, 'utf8');
const permBlock = manifestText.match(/permissions\s*:\s*\[([\s\S]*?)\]/);
const granted = new Set([...(permBlock?.[1] ?? '').matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) yield full;
  }
}

const used = new Map(); // namespace -> [{file, line}]
for await (const file of walk(SRC)) {
  const text = await readFile(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/(?<![\w.])chrome\.(\w+)/g)) {
      const ns = m[1];
      if (!REQUIRES[ns]) continue;
      if (!used.has(ns)) used.set(ns, []);
      used.get(ns).push({ file: relative(process.cwd(), file), line: i + 1 });
    }
  });
}

const missing = [...used.entries()].filter(([ns]) => !granted.has(REQUIRES[ns]));

if (missing.length) {
  console.error(`\n✗ Permission guard: ${missing.length} namespace(s) used without a manifest permission\n`);
  for (const [ns, sites] of missing) {
    console.error(`  chrome.${ns} needs "${REQUIRES[ns]}" in manifest.config.ts permissions`);
    for (const s of sites.slice(0, 3)) console.error(`    used at ${s.file}:${s.line}`);
    if (sites.length > 3) console.error(`    …and ${sites.length - 3} more`);
    console.error('');
  }
  console.error('  Undeclared namespaces are undefined at runtime. In a service worker that');
  console.error('  throws during module evaluation and registration fails silently.\n');
  process.exit(1);
}

const unused = [...granted].filter(
  (p) => Object.values(REQUIRES).includes(p) && ![...used.keys()].some((ns) => REQUIRES[ns] === p),
);
if (unused.length) {
  console.log(`⚠ Permission guard: declared but unused: ${unused.join(', ')}`);
}

console.log(`✓ Permission guard: ${used.size} chrome.* namespace(s) all declared`);
