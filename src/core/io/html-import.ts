import { ingest, type ImportResult } from './ingest';
import type { FolderRules } from './folder-tags';
import type { BookmarkStatus, RawEntry } from '../types';

/**
 * Netscape bookmark HTML → our records. The format every browser exports.
 *
 * **Parsed with regex over lines, not DOMParser.** `src/core/` may not touch the DOM
 * (scripts/guard-isolation.mjs), which keeps this testable in plain node and usable from
 * a service worker. That is not a compromise here: the format is machine-generated, one
 * tag per line, and this approach was validated against a full-size real export before
 * being written.
 *
 * The format, in full:
 *
 *     <DL><p>
 *         <DT><H3 ADD_DATE="…" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
 *         <DL><p>
 *             <DT><A HREF="…" ADD_DATE="…" ICON="data:…">Title</A>
 *         </DL><p>
 *     </DL><p>
 *
 * `<H3>` opens a folder, `</DL>` closes one. There is no closing tag for `<DT>`, and
 * indentation is not reliable, so the `</DL>` count is the only sound way to track depth.
 */

/** The toolbar root, which must not become a tag. */
const TOOLBAR_ATTR = /PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i;

const FOLDER = /<H3[^>]*>(.*?)<\/H3>/i;
const CLOSE = /<\/DL>/i;
const LINK = /<A\s+HREF="([^"]*)"([^>]*)>(.*?)<\/A>/i;
const ADD_DATE = /ADD_DATE="(\d+)"/i;

/**
 * Chrome writes the five XML entities and nothing else — no numeric escapes beyond
 * `&#39;`, no named entities like `&nbsp;`. `&amp;` is decoded last so that a literal
 * `&amp;lt;` in a title survives as `&lt;` rather than decoding twice.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Netscape HTML → entries.
 *
 * Never throws on malformed input: an unbalanced `</DL>` clamps at the root rather than
 * producing a negative depth, because a truncated or hand-edited export should still
 * yield everything above the damage.
 */
export function htmlToEntries(html: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const path: string[] = [];

  for (const line of html.split('\n')) {
    const folder = FOLDER.exec(line);
    if (folder) {
      // The toolbar root is a container, not a subject. Push a marker so the matching
      // </DL> still pops something, but keep it out of the path.
      const title = TOOLBAR_ATTR.test(line) ? '' : decodeEntities(folder[1]!).trim();
      path.push(title);
      continue;
    }

    if (CLOSE.test(line)) {
      path.pop();
      continue;
    }

    const link = LINK.exec(line);
    if (!link) continue;

    const date = ADD_DATE.exec(link[2]!);
    entries.push({
      url: decodeEntities(link[1]!),
      title: decodeEntities(link[3]!),
      // Empty segments are the toolbar root and unnamed folders — never tags.
      folderPath: path.filter(Boolean),
      // Chrome writes ADD_DATE in seconds; everything downstream is milliseconds.
      ...(date && { dateAdded: Number(date[1]) * 1000 }),
    });
  }

  return entries;
}

export interface HtmlImportOptions {
  now?: number;
  /** Where ordinary records land. Saved tab sets still override this to 'inbox'. */
  status?: BookmarkStatus;
  /** Folder names specific to this tree; see config/folder-rules.example.json. */
  rules?: FolderRules;
}

export function htmlToBookmarks(
  html: string,
  options: HtmlImportOptions = {},
): ImportResult {
  const { now, status, rules } = options;
  return ingest(htmlToEntries(html), {
    kind: 'html-import',
    ...(now !== undefined && { now }),
    ...(status !== undefined && { status }),
    ...(rules !== undefined && { rules }),
  });
}
