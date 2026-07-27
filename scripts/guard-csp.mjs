#!/usr/bin/env node
/**
 * MV3 Content Security Policy guard.
 *
 * MV3 forbids the Function constructor and eval, and unlike MV2 the policy
 * CANNOT be relaxed — 'unsafe-eval' is rejected at install time. A dependency
 * that reaches for either one fails at runtime in Chrome, not at build time,
 * which is a miserable way to find out.
 *
 * Note the pattern catches the BARE `Function(...)` form as well as `new Function(...)`.
 * That matters: Vue's runtime template compiler appears as a bare call, and a
 * `new Function`-only check misses it entirely.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const PATTERN = /(?<![\w.])(new\s+Function\s*\(|Function\s*\(\s*['"`]|(?<![\w.$])eval\s*\()/;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    console.error('✗ CSP guard: dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

const hits = [];
for await (const file of walk(DIST)) {
  const text = await readFile(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (PATTERN.test(line)) {
      hits.push({
        file: relative(process.cwd(), file),
        line: i + 1,
        // Bundled lines can be enormous; show only the neighbourhood of the match.
        excerpt: line.slice(Math.max(0, line.search(PATTERN) - 60), line.search(PATTERN) + 100),
      });
    }
  });
}

if (hits.length) {
  console.error(`\n✗ CSP guard: ${hits.length} Function-constructor/eval use(s) in dist/\n`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}`);
    console.error(`    …${h.excerpt}…\n`);
  }
  console.error('  MV3 blocks these and the policy cannot be relaxed. Replace the dependency.\n');
  process.exit(1);
}

console.log('✓ CSP guard: dist/ is free of Function-constructor and eval use');
