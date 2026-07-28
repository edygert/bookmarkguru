import { ingest, type ImportResult } from './ingest';
import { mapChromeGroupColor } from '../tags';
import type { TabLike } from '../tabs/match';
import type { BookmarkStatus, RawEntry, SourceTag } from '../types';

export type { ImportResult };

/**
 * Open tabs → our records.
 *
 * The third import path, and the only one whose source is not a tree. A window full of
 * tabs is a *triage queue*, not library material, so captures land in the inbox by
 * default — the same reasoning that routes saved tab sets there on an HTML import.
 *
 * There is no folder path to mine, so this file supplies `sourceTags` instead: the tab
 * group's title and the window it was in. Those deliberately bypass the folder rules —
 * see `SourceTag` in types.ts for why that matters. Everything downstream (dedupe, tag
 * union, status routing) is `ingest.ts`, shared with the other two paths.
 */

/** Structural shape of chrome.tabGroups.TabGroup — no chrome types needed. */
export interface TabGroupLike {
  id: number;
  title?: string | undefined;
  color?: string | undefined;
}

export interface TabImportOptions {
  now?: number;
  /** Groups to resolve `tab.groupId` against. Tabs in unknown groups get no group tag. */
  groups?: readonly TabGroupLike[];
  /** Where captures land. A tab dump is a triage queue, hence 'inbox'. */
  status?: BookmarkStatus;
  /**
   * `windowId` → 1-based ordinal, so a tag reads `Window 3` rather than `Window 1849473`.
   *
   * ⚠️ Pass ordinals computed over **every** open window when importing a filtered
   * subset. Left to default, a one-window selection renumbers itself to `Window 1` and
   * silently mislabels the capture.
   */
  windowOrdinals?: ReadonlyMap<number, number>;
  /** Tag each tab with its window. Off gives group tags only. Default on. */
  tagWindows?: boolean;
}

/**
 * Number the windows these tabs came from, 1-based.
 *
 * Ordered by window id ascending, which is creation order — Chrome hands out increasing
 * ids — so `Window 1` is the oldest window rather than whichever one `chrome.tabs.query`
 * happened to list first. That keeps the numbering stable across two captures in a row.
 */
export function windowOrdinals(tabs: readonly TabLike[]): Map<number, number> {
  const ids = [...new Set(
    tabs.map((t) => t.windowId).filter((id): id is number => id !== undefined),
  )].sort((a, b) => a - b);

  return new Map(ids.map((id, i) => [id, i + 1]));
}

/** Flatten tabs to entries. Unusable URLs are left for `ingest` to count as skipped. */
export function tabsToEntries(
  tabs: readonly TabLike[],
  options: TabImportOptions = {},
): RawEntry[] {
  const { groups = [], tagWindows = true } = options;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const ordinals = options.windowOrdinals ?? windowOrdinals(tabs);

  const entries: RawEntry[] = [];

  for (const tab of tabs) {
    if (!tab.url) continue;

    // Chrome uses -1 for an ungrouped tab, so a plain `!== undefined` check is not enough.
    const group = tab.groupId !== undefined && tab.groupId >= 0
      ? groupById.get(tab.groupId)
      : undefined;
    const groupTitle = group?.title?.trim();

    const sourceTags: SourceTag[] = [];
    // An untitled group carries no meaning worth a tag, but it does keep its colour, so
    // the row still reads as grouped in the list.
    if (groupTitle) {
      sourceTags.push({ name: groupTitle, color: mapChromeGroupColor(group?.color) });
    }

    const ordinal = tab.windowId === undefined ? undefined : ordinals.get(tab.windowId);
    if (tagWindows && ordinal !== undefined) sourceTags.push({ name: `Window ${ordinal}` });

    entries.push({
      url: tab.url,
      title: tab.title?.trim() || tab.url,
      folderPath: [],
      ...(sourceTags.length > 0 && { sourceTags }),
      ...(tab.windowId !== undefined && { windowId: tab.windowId }),
      ...(groupTitle !== undefined && groupTitle !== '' && { tabGroup: groupTitle }),
    });
  }

  return entries;
}

export function tabsToBookmarks(
  tabs: readonly TabLike[],
  options: TabImportOptions = {},
): ImportResult {
  const { now, status = 'inbox' } = options;

  return ingest(tabsToEntries(tabs, options), {
    kind: 'tab-import',
    status,
    ...(now !== undefined && { now }),
  });
}
