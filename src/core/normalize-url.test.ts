import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  normalizeForDedupe,
  normalizeForMatch,
  domainOf,
  isIngestable,
} from './normalize-url';

describe('normalizeUrl', () => {
  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path/To/Thing'))
      .toBe('https://example.com/Path/To/Thing');
  });

  it('drops default ports', () => {
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('keeps non-default ports', () => {
    expect(normalizeUrl('http://localhost:5173/a')).toBe('http://localhost:5173/a');
  });

  it('drops the trailing slash only for the root path', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    // /a/ and /a can be genuinely different resources — do not collapse them.
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a/');
  });

  it('sorts query params so order stops mattering', () => {
    expect(normalizeUrl('https://e.com/?b=2&a=1')).toBe(normalizeUrl('https://e.com/?a=1&b=2'));
  });

  it('strips utm_* and known tracking params', () => {
    expect(normalizeUrl('https://e.com/p?utm_source=x&utm_campaign=y&id=7'))
      .toBe('https://e.com/p?id=7');
    expect(normalizeUrl('https://e.com/p?fbclid=abc')).toBe('https://e.com/p');
  });

  it('leaves no dangling "?" when every param was stripped', () => {
    expect(normalizeUrl('https://e.com/p?utm_source=x')).toBe('https://e.com/p');
  });

  it('does not throw on unparseable input', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
    expect(normalizeUrl('')).toBe('');
  });
});

describe('presets differ where it matters', () => {
  it('dedupe collapses fragments; match preserves them', () => {
    const a = 'https://docs.dev/guide#install';
    const b = 'https://docs.dev/guide';
    expect(normalizeForDedupe(a)).toBe(normalizeForDedupe(b));
    // Focusing the wrong tab is worse than opening a second one.
    expect(normalizeForMatch(a)).not.toBe(normalizeForMatch(b));
  });

  it('match preserves tracking params so the exact tab still matches', () => {
    expect(normalizeForMatch('https://e.com/p?utm_source=x'))
      .toBe('https://e.com/p?utm_source=x');
  });
});

describe('domainOf', () => {
  it('strips www and lowercases', () => {
    expect(domainOf('https://WWW.Example.com/a')).toBe('example.com');
  });

  it('falls back to the scheme for hostless URLs', () => {
    // The domain leads every row, so an empty value would render a bare placeholder.
    expect(domainOf('file:///home/me/notes.html')).toBe('file://');
  });

  it('groups all local files under one filterable value', () => {
    expect(domainOf('file:///a/b.html')).toBe(domainOf('file:///c/d.html'));
  });

  it('returns empty string when unparseable', () => {
    expect(domainOf('garbage')).toBe('');
  });
});

describe('isIngestable', () => {
  it('rejects browser-internal schemes', () => {
    for (const u of [
      'chrome://extensions',
      'chrome-extension://abc/page.html',
      'about:blank',
      'devtools://devtools/bundled/x.html',
      'javascript:void(0)',
    ]) {
      expect(isIngestable(u), u).toBe(false);
    }
  });

  it('accepts http, https, and local files', () => {
    expect(isIngestable('https://example.com')).toBe(true);
    expect(isIngestable('http://localhost:3000')).toBe(true);
    expect(isIngestable('file:///home/me/notes.html')).toBe(true);
  });

  it('rejects empty and malformed input', () => {
    expect(isIngestable('')).toBe(false);
    expect(isIngestable('   ')).toBe(false);
    expect(isIngestable('not a url')).toBe(false);
  });
});
