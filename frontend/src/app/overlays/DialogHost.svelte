<!-- Renders confirm() / prompt() requests one at a time. -->
<script lang="ts">
  import Button from '../../components/Button.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Input from '../../components/Input.svelte';
  import { dialogQueue } from './dialogs.svelte';

  const uid = $props.id();
  const formId = `${uid}-form`;
  const current = $derived(dialogQueue.current);

  let open = $state(false);
  let value = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let shownId = -1;

  $effect(() => {
    const c = current;
    if (!c || c.id === shownId) return;
    shownId = c.id;
    value = c.kind === 'prompt' ? (c.initial ?? '') : '';
    error = null;
    busy = false;
    open = true;
  });

  function finish(result: boolean | string | null): void {
    const c = current;
    if (!c) return;
    if (c.kind === 'confirm') c.resolve(result === true);
    else c.resolve(typeof result === 'string' ? result : null);
    open = false;
    const id = c.id;
    // Let the exit animation play before the next request (if any) opens.
    setTimeout(() => dialogQueue.settle(id), 280);
  }

  function cancel(): void {
    if (busy) return;
    finish(current?.kind === 'confirm' ? false : null);
  }

  async function submit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const c = current;
    if (!c || c.kind !== 'prompt' || busy) return;
    const v = value;
    const syncError = c.validate?.(v) ?? null;
    if (syncError) {
      error = syncError;
      return;
    }
    if (c.submit) {
      busy = true;
      try {
        const asyncError = await c.submit(v);
        if (asyncError) {
          error = asyncError;
          return;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Something went wrong.';
        return;
      } finally {
        busy = false;
      }
    }
    finish(v);
  }
</script>

{#if current}
  <Dialog
    bind:open
    title={current.title}
    description={current.message}
    size="sm"
    role={current.kind === 'confirm' ? 'alertdialog' : 'dialog'}
    dismissible={!busy}
    initialFocus={current.kind === 'prompt' ? 'input' : current.danger ? '[data-cancel]' : '[data-confirm]'}
    onclose={cancel}
  >
    {#if current.kind === 'prompt'}
      <form id={formId} onsubmit={submit} novalidate>
        <Field label={current.label} error={error}>
          <Input
            bind:value
            size="lg"
            type={current.inputType ?? 'text'}
            placeholder={current.placeholder}
            mono={current.mono}
            autocomplete={(current.autocomplete ?? 'off') as never}
            disabled={busy}
            oninput={() => (error = null)}
          />
        </Field>
      </form>
    {/if}
    {#snippet footer()}
      {#if current}
        <Button variant="ghost" data-cancel disabled={busy} onclick={cancel}>{current.cancelLabel ?? 'Cancel'}</Button>
        {#if current.kind === 'prompt'}
          <Button variant="primary" type="submit" form={formId} loading={busy}>{current.confirmLabel ?? 'OK'}</Button>
        {:else}
          <Button variant={current.danger ? 'danger' : 'primary'} data-confirm onclick={() => finish(true)}>
            {current.confirmLabel ?? 'Confirm'}
          </Button>
        {/if}
      {/if}
    {/snippet}
  </Dialog>
{/if}
