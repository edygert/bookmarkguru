#!/usr/bin/env node
/**
 * Make sure config/folder-rules.json exists.
 *
 * The real file is gitignored — folder names from a bookmark tree are personal data —
 * but the build imports it statically, so a fresh clone would fail without this. Copies
 * the committed example across on first run and never touches it again.
 */
import { copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = new URL('../config/', import.meta.url);
const real = fileURLToPath(new URL('folder-rules.json', dir));
const example = fileURLToPath(new URL('folder-rules.example.json', dir));

try {
  await access(real);
} catch {
  await copyFile(example, real);
  console.log('✓ created config/folder-rules.json from the example (gitignored, yours to edit)');
}
