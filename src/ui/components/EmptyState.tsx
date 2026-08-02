import { Show } from 'solid-js';

/**
 * Empty screens are an invitation to act, so each one names the single next step
 * rather than just reporting that there is nothing here.
 */
export function EmptyState(props: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
  /** What the import is doing right now, when it is saying so. */
  busyLabel?: string;
  /** A second way out, when the obvious next step is not the only sensible one. */
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div class="empty">
      <div class="empty__title">{props.title}</div>
      <p class="empty__body">{props.body}</p>
      <div class="empty__actions">
        <Show when={props.actionLabel}>
          <button
            type="button"
            class="btn btn--primary"
            onClick={() => props.onAction?.()}
            disabled={props.busy}
          >
            {props.busy ? props.busyLabel ?? 'Importing…' : props.actionLabel}
          </button>
        </Show>
        <Show when={props.secondaryLabel}>
          <button type="button" class="btn" onClick={() => props.onSecondary?.()}>
            {props.secondaryLabel}
          </button>
        </Show>
      </div>
    </div>
  );
}
