<!-- Add / edit a quick link: name + address (validated as an http(s) address). -->
<script lang="ts">
  import Button from '../../components/Button.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Input from '../../components/Input.svelte';
  import { hostOf, normalizeLinkUrl } from '../../lib/url';

  interface Props {
    open: boolean;
    mode: 'add' | 'edit';
    initial?: { title: string; url: string } | null;
    onsave: (link: { title: string; url: string }) => void;
  }

  let { open = $bindable(false), mode, initial = null, onsave }: Props = $props();

  const uid = $props.id();
  let title = $state('');
  let address = $state('');
  let error = $state<string | null>(null);

  $effect(() => {
    if (open) {
      title = initial?.title ?? '';
      address = initial?.url ?? '';
      error = null;
    }
  });

  function save(ev: SubmitEvent): void {
    ev.preventDefault();
    const url = normalizeLinkUrl(address);
    if (!url) {
      error = address.trim() ? 'Enter a web address such as example.com.' : 'Enter an address.';
      return;
    }
    onsave({ title: title.trim().slice(0, 80) || hostOf(url), url });
    open = false;
  }
</script>

<Dialog bind:open title={mode === 'add' ? 'Add quick link' : 'Edit quick link'} size="sm" initialFocus={mode === 'add' ? '[data-address] input' : 'input'}>
  <form id="{uid}-form" class="form" onsubmit={save} novalidate>
    <Field label="Name" help="Leave empty to use the site's address.">
      <Input bind:value={title} placeholder="Optional" maxlength={80} autocomplete="off" />
    </Field>
    <div data-address>
      <Field label="Address" {error} required>
        <Input
          bind:value={address}
          placeholder="wikipedia.org"
          mono
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          oninput={() => (error = null)}
        />
      </Field>
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="{uid}-form">{mode === 'add' ? 'Add' : 'Save'}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
