import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'BookmarkGuru',
  version: pkg.version,
  description: 'A searchable, tag-based link database with tab awareness.',

  // No host_permissions by design: favicons come from Chrome's own cache via the
  // `favicon` permission, so the extension never makes an outbound request and the
  // install prompt never says "read your data on all websites".
  permissions: [
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabGroups',
    'sidePanel',
    'favicon',
    // Required by the service worker's chrome.contextMenus calls. Without it the
    // namespace is undefined, .addListener throws during module evaluation, and the
    // whole service worker silently fails to register. Adds no install warning.
    'contextMenus',
    // Read-only. Used for one-directional first-run migration only; we never write back.
    'bookmarks',
  ],

  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  /*
   * Served from `public/`, which Vite copies to the bundle root verbatim — so these
   * paths are `icons/…`, not `public/icons/…`. Regenerate with
   * `python3 scripts/make-icons.py`; that script is the editable source, not the PNGs.
   */
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },

  action: {
    default_popup: 'src/ui/popup.html',
    default_title: 'Save this tab to BookmarkGuru',
    // Chrome picks per display density: 16 at 1x, 32 at 2x. Without this the toolbar
    // falls back to a generic placeholder even when `icons` above is set.
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
    },
  },

  side_panel: {
    default_path: 'src/ui/panel.html',
  },

  commands: {
    _execute_action: {
      suggested_key: { default: 'Ctrl+Shift+D', mac: 'Command+Shift+D' },
    },
    'open-manager': {
      suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      description: 'Open BookmarkGuru',
    },
  },

  // Strict default. Solid compiles JSX ahead of time, so nothing in the bundle
  // needs eval(). `npm run guard:csp` proves this against the built output.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
});
