<!-- Add or edit a bookmark or folder: name, address (bookmarks), folder, favorite (bookmarks; device-local). -->
<script lang="ts">
  import Button from '../../components/Button.svelte';
  import Checkbox from '../../components/Checkbox.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Input from '../../components/Input.svelte';
  import Select from '../../components/Select.svelte';
  import type { FolderNode } from '../../library/ui/view';
  import type { Bookmark } from '../../shared/browser-data';
  import type { BookmarkDraft, SaveError } from './types';

  interface Props {
    open: boolean;
    /** null: add a new item of `draft.kind`. */
    editing: Bookmark | null;
    draft: BookmarkDraft;
    folders: readonly FolderNode[];
    /** Folder ids the item may not move into (itself and its subfolders). */
    forbidden: ReadonlySet<string>;
    /** Resolves null when saved, else the error to show (under the address or the folder). */
    onsave: (draft: BookmarkDraft) => Promise<SaveError | null>;
    onclose: () => void;
  }

  let { open = $bindable(), editing, draft, folders, forbidden, onsave, onclose }: Props = $props();

  let title = $state('');
  let url = $state('');
  let parentId = $state('');
  let favorite = $state(false);
  let error = $state<SaveError | null>(null);
  let busy = $state(false);
  let lastKey = '';

  $effect(() => {
    // Reset the form whenever the dialog opens for another item.
    const key = `${open}|${editing?.id ?? 'new'}|${draft.kind}|${draft.parentId}|${draft.url}`;
    if (!open || key === lastKey) return;
    lastKey = key;
    title = draft.title;
    url = draft.url;
    parentId = draft.parentId;
    favorite = draft.favorite;
    error = null;
  });
  $effect(() => {
    if (!open) lastKey = '';
  });

  const isFolder = $derived(draft.kind === 'folder');
  const heading = $derived(editing ? (isFolder ? 'Edit folder' : 'Edit bookmark') : isFolder ? 'New folder' : 'Add bookmark');
  const options = $derived(
    folders.filter((f) => !forbidden.has(f.id)).map((f) => ({ value: f.id, label: `${'\u00a0\u00a0\u00a0'.repeat(f.depth)}${f.title}` })),
  );

  async function save(ev?: SubmitEvent): Promise<void> {
    ev?.preventDefault();
    busy = true;
    error = await onsave({ kind: draft.kind, title, url, parentId, favorite });
    busy = false;
    if (!error) {
      open = false;
      onclose();
    }
  }
</script>

<Dialog bind:open title={heading} size="md" {onclose} initialFocus={isFolder || editing ? '#bm-title' : '#bm-url'}>
  <form class="form" onsubmit={save} id="bookmark-form">
    {#if !isFolder}
      <Field label="Address" id="bm-url" error={error?.field === 'url' ? error.message : null}>
        <Input bind:value={url} size="lg" mono placeholder="https://" autocomplete="off" spellcheck={false} inputmode="url" />
      </Field>
    {/if}
    <Field label="Name" id="bm-title" help={isFolder ? undefined : 'Leave empty to use the site’s name.'}>
      <Input bind:value={title} size="lg" maxlength={512} autocomplete="off" />
    </Field>
    <Field label="Folder" id="bm-folder" error={error?.field === 'folder' ? error.message : null}>
      <Select value={parentId} {options} onchange={(v) => (parentId = v)} size="lg" full />
    </Field>
    {#if !isFolder}
      <Checkbox label="Show on Home under Favorites" description="Favorites stay in this browser; they are not synced." checked={favorite} onchange={(v) => (favorite = v)} />
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())}>Cancel</Button>
    <Button variant="primary" loading={busy} type="submit" form="bookmark-form">{editing ? 'Save' : isFolder ? 'Create folder' : 'Add bookmark'}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
</style>
