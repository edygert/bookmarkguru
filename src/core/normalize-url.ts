/**
 * URL normalization.
 *
 * Two different jobs use this, and they want different aggressiveness:
 *
 *  - **Dedupe / indexing** wants to collapse cosmetic variants, so it strips
 *    fragments and tracking parameters.
 *  - **Open-or-switch matching** wants to respect what the user actually meant, so
 *    it keeps both. A fragment is frequently the real destination (`/docs#install`
 *    is not `/docs`), and switching to the wrong tab is worse than opening a new one.
 *
 * Hence the options, and hence the two presets at the bottom.
 */

export interface NormalizeOpts {
  /** Drop `#fragment`. Default true. */
  stripFragment?: boolean;
  /** Drop known analytics/tracking query params. Default true. */
  stripTracking?: boolean;
  /** Sort remaining query params so param order stops mattering. Default true. */
  sortParams?: boolean;
}

/**
 * Exact parameter names to drop, plus the `utm_*` prefix rule below.
 *
 * `ref` is included because it is overwhelmingly a referrer tag, but it is
 * occasionally semantic. That is acceptable here: tracking-stripping is only
 * default-on for dedupe, which collapses exact-key repeats and unions their tags
 * rather than discarding anything.
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid',
  'igshid', 'mc_cid', 'mc_eid', 'vero_id', 'oly_enc_id', 'oly_anon_id',
  '_hsenc', '_hsmi', 'hsCtaTracking', 'mkt_tok', 'trk', 'trkCampaign',
  'ref', 'ref_src', 'ref_url', 'referrer', 'source', 'src',
  '_ga', '_gl', 'icid', 'ncid', 'cmpid', 'campaign_id',
]);

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
};

/**
 * Schemes we refuse to store. Browser-internal pages are not useful bookmarks and
 * cannot be reopened reliably across profiles or versions.
 * `file:` is deliberately allowed — local docs are legitimate to save.
 */
const UNINGESTABLE_SCHEMES = new Set([
  'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:',
  'edge:', 'brave:', 'opera:', 'vivaldi:',
  'about:', 'devtools:', 'view-source:', 'javascript:', 'data:', 'blob:',
]);

/**
 * Produce the key used for matching, dedupe, and indexing.
 *
 * Never throws: an unparseable string is returned trimmed and lowercased so that
 * malformed input from an import file still round-trips to something stable rather
 * than blowing up a 5,000-record batch.
 */
export function normalizeUrl(raw: string, opts: NormalizeOpts = {}): string {
  const {
    stripFragment = true,
    stripTracking = true,
    sortParams = true,
  } = opts;

  const input = raw.trim();
  if (!input) return '';

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input.toLowerCase();
  }

  // Scheme and host are case-insensitive per RFC 3986; path and query are not.
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if (u.port && DEFAULT_PORTS[u.protocol] === u.port) u.port = '';

  if (stripTracking && u.search) {
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
  }

  if (sortParams && u.search) {
    u.searchParams.sort();
  }

  if (stripFragment) u.hash = '';

  let out = u.toString();

  // `new URL('https://x.com')` yields a trailing slash. Drop it only for the root
  // path, so `/a/` and `/a` stay distinct — some servers genuinely differentiate.
  if (u.pathname === '/' && !u.search && !u.hash) {
    out = out.replace(/\/$/, '');
  }

  // URLSearchParams re-encodes an emptied query as a bare '?'.
  out = out.replace(/\?(?=#|$)/, '');

  return out;
}

/** Preset for dedupe, search indexing, and duplicate review. */
export function normalizeForDedupe(raw: string): string {
  return normalizeUrl(raw, { stripFragment: true, stripTracking: true });
}

/**
 * Preset for open-or-switch. Conservative on purpose: focusing the wrong tab is a
 * worse failure than opening a second one.
 */
export function normalizeForMatch(raw: string): string {
  return normalizeUrl(raw, { stripFragment: false, stripTracking: false });
}

/**
 * Host used for the domain column and for sorting by domain.
 *
 * Hostless schemes (`file:`, and anything else without an authority) fall back to the
 * scheme itself rather than an empty string. The domain leads every row, so an empty
 * value would leave a bare placeholder there, and `file://` both names the scheme and
 * sorts every local file together.
 *
 * Returns '' only when the input cannot be parsed at all.
 */
export function domainOf(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host || `${u.protocol}//`;
  } catch {
    return '';
  }
}

/** Whether this URL is worth storing at all. */
export function isIngestable(raw: string): boolean {
  const input = raw?.trim();
  if (!input) return false;
  try {
    return !UNINGESTABLE_SCHEMES.has(new URL(input).protocol);
  } catch {
    return false;
  }
}
