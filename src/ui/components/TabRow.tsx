import { Match, Show, Switch } from 'solid-js';
import { Favicon } from './Favicon';
import type { OpenTab } from '../state/library';

/**
 * One open tab.
 *
 * Shares `.row` with the bookmark list — same height, same domain-leads layout, so the
 * two views scan identically — but **never sets `data-open`**. Amber means "this link is
 * open in a tab right now", and in a list where that is true of every row it says
 * nothing. The fact worth signalling here is the opposite one: whether the tab is
 * already in the library. That gets the dot, and unsaved rows get the action.
 *
 * A `div` rather than a `button`, because the Save control nests inside the row and a
 * button inside a button is invalid.
 */
export function TabRow(props: {
  tab: OpenTab;
  isSelected: boolean;
  onSelect: () => void;
  onActivate: (tab: OpenTab) => void;
  onSave: (tab: OpenTab) => void;
}) {
  const saved = () => props.tab.bookmarkId !== undefined;

  return (
    <div
      class="row row--tab"
      role="option"
      aria-selected={props.isSelected}
      data-saved={saved()}
      onClick={() => props.onSelect()}
      onDblClick={() => props.onActivate(props.tab)}
      title={props.tab.url}
    >
      <span class="row__dot" aria-label={saved() ? 'Already saved' : undefined} />
      <Favicon url={props.tab.url} />
      <span class="row__domain">{props.tab.domain || '—'}</span>
      <span class="row__title">{props.tab.title}</span>

      <span class="row__tags">
        <Show when={props.tab.groupTitle}>
          {(title) => (
            <span
              class="chip"
              style={{ '--tag-color': `var(--tag-${props.tab.groupColor ?? 'slate'})` }}
            >
              {title()}
            </span>
          )}
        </Show>
        <span class="row__meta">W{props.tab.windowOrdinal}</span>
      </span>

      <Switch>
        <Match when={saved()}>
          <span class="row__meta row__meta--saved">saved</span>
        </Match>
        {/* A browser-internal page. Shown, because it is genuinely open, but there is
            nothing to offer — `isIngestable` would refuse it. */}
        <Match when={!props.tab.saveable}>
          <span class="row__meta">—</span>
        </Match>
        <Match when={true}>
          <button
            type="button"
            class="row__action"
            /* Without this the row's own click handler also fires and moves the cursor,
               which is harmless but makes the button feel like it did two things. */
            onClick={(e) => {
              e.stopPropagation();
              props.onSave(props.tab);
            }}
          >
            Save
          </button>
        </Match>
      </Switch>
    </div>
  );
}
