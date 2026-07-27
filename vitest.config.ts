import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Deliberately separate from vite.config.ts: the CRXJS plugin builds an extension
 * bundle and has no business running during unit tests. Everything under src/core/
 * is pure by contract (see scripts/guard-isolation.mjs), so plain node is enough —
 * no jsdom, no browser, no Chrome stubs.
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
