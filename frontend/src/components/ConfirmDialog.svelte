<!-- Yes/no confirmation (alertdialog). Destructive confirmations use `danger` and focus Cancel first. -->
<script lang="ts">
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';

  interface Props {
    open: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    busy?: boolean;
    onconfirm: () => void | Promise<void>;
    oncancel?: () => void;
  }

  let {
    open = $bindable(false),
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
    busy = false,
    onconfirm,
    oncancel,
  }: Props = $props();

  let working = $state(false);

  async function confirm(): Promise<void> {
    working = true;
    try {
      await onconfirm();
      open = false;
    } finally {
      working = false;
    }
  }
</script>

<Dialog
  bind:open
  {title}
  size="sm"
  role="alertdialog"
  description={message}
  dismissible={!(busy || working)}
  initialFocus={danger ? '[data-cancel]' : '[data-confirm]'}
  onclose={() => oncancel?.()}
>
  {#snippet footer()}
    <Button
      variant="ghost"
      data-cancel
      disabled={busy || working}
      onclick={() => {
        open = false;
        oncancel?.();
      }}>{cancelLabel}</Button
    >
    <Button variant={danger ? 'danger' : 'primary'} data-confirm loading={busy || working} onclick={confirm}>{confirmLabel}</Button>
  {/snippet}
</Dialog>
