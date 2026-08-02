import { describe, it, expect } from 'vitest';
import { htmlToBookmarks, htmlToEntries } from './html-import';

/**
 * Parser tests: nesting, root detection, escaping, and tolerance of damage.
 *
 * Documents are generated from a tree rather than written as literals, so a test states
 * the *structure* under test instead of a wall of markup. Folder names are abstract.
 */

const NOW = 1_700_000_000_000;

type Node =
  | { folder: string; toolbar?: boolean; children: Node[] }
  | { link: string; title?: string; attrs?: string };

function render(nodes: readonly Node[], indent = ''): string[] {
  return nodes.flatMap((node) => {
    if ('link' in node) {
      const attrs = node.attrs ? ` ${node.attrs}` : '';
      return [`${indent}<DT><A HREF="${node.link}"${attrs}>${node.title ?? 'T'}</A>`];
    }
    const toolbar = node.toolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
    return [
      `${indent}<DT><H3 ADD_DATE="1"${toolbar}>${node.folder}</H3>`,
      `${indent}<DL><p>`,
      ...render(node.children, `${indent}    `),
      `${indent}</DL><p>`,
    ];
  });
}

/** A complete Netscape document wrapping the given tree. */
function doc(nodes: readonly Node[]): string {
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    ...render(nodes),
    '</DL><p>',
  ].join('\n');
}

const link = (n: number): Node => ({ link: `https://h${n}.example.com/` });

describe('htmlToEntries — structure', () => {
  it('reconstructs the folder path at every depth', () => {
    const entries = htmlToEntries(doc([
      { folder: 'P1', children: [
        link(1),
        { folder: 'P2', children: [
          link(2),
          { folder: 'P3', children: [link(3)] },
        ]},
      ]},
      link(4),
    ]));

    expect(entries.map((e) => e.folderPath)).toEqual([
      ['P1'], ['P1', 'P2'], ['P1', 'P2', 'P3'], [],
    ]);
  });

  it('tracks depth by close tags, not by indentation', () => {
    // Indentation is not reliable in real exports and <DT> has no closing tag, so the
    // </DL> count is the only sound signal. Same tree, no indentation at all.
    const nodes: Node[] = [{ folder: 'P1', children: [{ folder: 'P2', children: [link(1)] }] }];
    const indented = htmlToEntries(doc(nodes));
    const flat = htmlToEntries(doc(nodes).split('\n').map((l) => l.trim()).join('\n'));
    expect(flat).toEqual(indented);
  });

  it('excludes the toolbar root by attribute, whatever it is called', () => {
    // Titles are localised; the attribute is not. Two names, one result.
    const paths = ['Bookmarks bar', 'Lesezeichenleiste'].map((folder) =>
      htmlToEntries(doc([
        { folder, toolbar: true, children: [{ folder: 'P1', children: [link(1)] }] },
      ]))[0]!.folderPath,
    );
    expect(paths[0]).toEqual(['P1']);
    expect(paths[0]).toEqual(paths[1]);
  });

  it('treats an unmarked folder of the same name as an ordinary folder', () => {
    // Only the attribute decides — a *user* folder called "Bookmarks bar" is still theirs
    // to keep at this layer. Dropping it by name is folder-tags.ts's job, not the parser's.
    const entries = htmlToEntries(doc([{ folder: 'Bookmarks bar', children: [link(1)] }]));
    expect(entries[0]!.folderPath).toEqual(['Bookmarks bar']);
  });
});

describe('htmlToEntries — field handling', () => {
  it('round-trips the escapes the format uses', () => {
    const title = 'A & B < C > D " E \' F';
    const html = doc([{ link: 'https://h1.example.com/?a=1&amp;b=2', title:
      title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;') }]);

    const entry = htmlToEntries(html)[0]!;
    expect(entry.title).toBe(title);
    expect(entry.url).toBe('https://h1.example.com/?a=1&b=2');
  });

  it('converts the timestamp from seconds to milliseconds', () => {
    const seconds = 1_700_000_000;
    const entry = htmlToEntries(doc([
      { link: 'https://h1.example.com/', attrs: `ADD_DATE="${seconds}"` },
    ]))[0]!;
    expect(entry.dateAdded).toBe(seconds * 1000);
  });

  it('leaves dateAdded unset when the source omits it', () => {
    expect(htmlToEntries(doc([link(1)]))[0]!.dateAdded).toBeUndefined();
  });

  it('is unaffected by attributes it does not consume', () => {
    // ICON carries base64 favicons — tens of MB across a real export, and no value here.
    const plain = htmlToEntries(doc([{ link: 'https://h1.example.com/' }]));
    const decorated = htmlToEntries(doc([{
      link: 'https://h1.example.com/',
      attrs: 'ICON_URI="https://h1.example.com/f.ico" ICON="data:image/png;base64,iVBORw0KGgo="',
    }]));
    expect(decorated).toEqual(plain);
  });
});

describe('htmlToEntries — damaged input', () => {
  it('clamps at the root rather than producing a negative depth', () => {
    const entries = htmlToEntries(['</DL><p>', '</DL><p>', ...render([link(1)])].join('\n'));
    expect(entries[0]!.folderPath).toEqual([]);
  });

  it('still yields everything above a truncation', () => {
    const full = doc([{ folder: 'P1', children: [link(1), link(2)] }]);
    const truncated = full.split('\n').slice(0, -2).join('\n');
    expect(htmlToEntries(truncated).length).toBeGreaterThan(0);
  });

  it('returns nothing for input with no links rather than throwing', () => {
    for (const input of ['', '<!DOCTYPE NETSCAPE-Bookmark-file-1>', doc([])]) {
      expect(htmlToEntries(input)).toEqual([]);
    }
  });
});

describe('htmlToBookmarks — composition', () => {
  it('applies folder tagging to the parsed tree', () => {
    // Composition only — the rules themselves are folder-tags.ts's tests.
    const result = htmlToBookmarks(
      doc([{ folder: 'P1', children: [{ folder: 'P2', children: [link(1)] }] }]),
      { now: NOW },
    );
    expect(result.bookmarks[0]!.tags).toEqual(['tag:p1', 'tag:p2']);
    expect(result.bookmarks[0]!.source.originalFolderPath).toBe('P1/P2');
  });

  it('qualifies a name the tree reaches through two parents', () => {
    const result = htmlToBookmarks(doc([
      { folder: 'P1', children: [{ folder: 'SHARED', children: [link(1)] }] },
      { folder: 'P2', children: [{ folder: 'SHARED', children: [link(2)] }] },
    ]), { now: NOW });

    const [first, second] = result.bookmarks;
    const qualified = (b: typeof first) => b!.tags.filter((t) => t.includes('/'));

    expect(qualified(first)).toHaveLength(1);
    expect(qualified(second)).toHaveLength(1);
    expect(qualified(first)).not.toEqual(qualified(second));
    // …while both keep the shared general tag.
    expect(first!.tags).toContain('tag:shared');
    expect(second!.tags).toContain('tag:shared');
  });
});
