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
}) {
  return (
    <div class="empty">
      <div class="empty__title">{props.title}</div>
      <p class="empty__body">{props.body}</p>
      <Show when={props.actionLabel}>
        <button
          type="button"
          class="btn btn--primary"
          onClick={() => props.onAction?.()}
          disabled={props.busy}
        >
          {props.busy ? 'Importing…' : props.actionLabel}
        </button>
      </Show>
    </div>
  );
}
