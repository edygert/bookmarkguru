import { Show } from 'solid-js';
import type { TagRow as TagRowData } from '../state/library';

/**
 * One tag.
 *
 * Shares `.row` with the other two lists — same height, so the windowing arithmetic in
 * `VirtualList` holds without a second row-height token — but leads with the colour dot
 * and the name rather than a domain, because a tag has no URL to lead with.
 *
 * The count is `usage.total`: records across **every** status, which is what deleting
 * this tag would touch. The sidebar's count next to the same tag is smaller and means
 * something else — rows its filter would show. Both are correct beside the control they
 * sit next to, and neither would be correct beside the other.
 */
export function TagRow(props: {
  row: TagRowData;
  isSelected: boolean;
  onSelect: () => void;
  onShowRecords: (id: string) => void;
}) {
  return (
    <div
      class="row row--tag"
      role="option"
      aria-selected={props.isSelected}
      data-unused={props.row.usage.total === 0}
      onClick={() => props.onSelect()}
      onDblClick={() => props.onShowRecords(props.row.tag.id)}
    >
      <span class="tag-dot" style={{ '--tag-color': `var(--tag-${props.row.tag.color})` }} />

      {/* A qualified tag keeps the plain name, so without the folder that distinguishes
          it two rows here would read identically. */}
      <Show when={props.row.parent}>
        {(parent) => <span class="row__domain">{parent().name}</span>}
      </Show>

      <span class="row__title">{props.row.tag.name}</span>

      <span class="row__meta">
        <Show when={props.row.usage.total > 0} fallback="unused">
          {props.row.usage.total} {props.row.usage.total === 1 ? 'record' : 'records'}
        </Show>
      </span>
    </div>
  );
}
