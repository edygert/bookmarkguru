import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [solid(), crx({ manifest })],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    // Extension review and the CSP guard are both easier to reason about
    // when the output isn't mangled beyond recognition.
    minify: 'esbuild',
    sourcemap: true,
    rollupOptions: {
      input: {
        // CRXJS derives its inputs from the manifest, which only declares the popup
        // and the side panel. The manager is opened programmatically via
        // chrome.runtime.getURL, so it has to be listed here or it never gets built.
        manager: fileURLToPath(new URL('./src/ui/manager.html', import.meta.url)),
      },
    },
  },
  server: {
    // CRXJS needs a stable port for HMR against the extension origin.
    port: 5173,
    strictPort: true,
  },
});
