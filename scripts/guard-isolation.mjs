#!/usr/bin/env node
/**
 * Framework isolation guard.
 *
 * src/core/ is the engine: repository, search, normalization, matching, import/export.
 * It must stay plain TypeScript over plain data, with no framework, no DOM, and no
 * Chrome APIs. That is what keeps it unit-testable in plain node and what makes the
 * view layer replaceable without touching business logic.
 *
 * Chrome *types* are fine (chrome.Tabs.Tab in a signature); Chrome *calls* are not.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const CORE = new URL('../src/core/', import.meta.url).pathname;

/** @type {{name: string, re: RegExp, hint: string}[]} */
const RULES = [
  {
    name: 'solid-js import',
    re: /from\s+['"]solid-js/,
    hint: 'Move the reactive wrapper into src/ui/state/ and keep core a pure function.',
  },
  {
    name: 'DOM access',
    // `document.` / `window.` as real accesses. Type positions don't match this.
    re: /(?<![\w.])(document|window)\s*\./,
    hint: 'Pass parsed data in instead. DOMParser callers belong in src/ui/.',
  },
  {
    name: 'chrome API call',
    // A call like `chrome.tabs.query(` — but NOT a type like `chrome.tabs.Tab`.
    re: /(?<![\w.])chrome\.[A-Za-z.]*[a-z]\w*\s*\(/,
    hint: 'Take the already-fetched data as an argument; call chrome.* from the caller.',
  },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

const violations = [];
for await (const file of walk(CORE)) {
  const text = await readFile(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    // Comments explaining the rule shouldn't trip the rule.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    for (const rule of RULES) {
      if (rule.re.test(code)) {
        violations.push({ file: relative(process.cwd(), file), line: i + 1, rule, text: line.trim() });
      }
    }
  });
}

if (violations.length) {
  console.error(`\n✗ Isolation guard: ${violations.length} violation(s) in src/core/\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule.name}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.rule.hint}\n`);
  }
  process.exit(1);
}

console.log('✓ Isolation guard: src/core/ is free of solid-js, DOM, and chrome.* calls');
