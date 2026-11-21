<!--
  Bookmark editor: the star, "Bookmark this page" and the forwarded bookmarkPage shortcut open it, so the user
  confirms what is saved (ENGINE-PROTOCOL §6.7: a forwarded key never saves silently). Edits or removes an existing
  bookmark of the URL; otherwise adds one to the chosen folder.
-->
<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Button from '../../components/Button.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Input from '../../components/Input.svelte';
  import Select from '../../components/Select.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { displayUrl } from '../../lib/url';
  import { BOOKMARK_ROOT, library, type Bookmark } from '../../shared/browser-data';
  import { browser } from '../browser.svelte';

  const req = $derived(browser.bookmarkEditor);
  let title = $state('');
  let folder = $state(BOOKMARK_ROOT);
  let existing = $state.raw<Bookmark | null>(null);
  let folders = $state.raw<Array<{ value: string; label: string }>>([{ value: BOOKMARK_ROOT, label: 'Bookmarks bar' }]);
  let busy = $state(false);

  $effect(() => {
    const r = req;
    if (!r) return;
    title = r.title || displayUrl(r.url);
    folder = BOOKMARK_ROOT;
    existing = null;
    const lib = library();
    if (!lib) return;
    void (async () => {
      const [found, top] = await Promise.all([lib.bookmarks.byUrl(r.url), lib.bookmarks.children(BOOKMARK_ROOT)]);
      folders = [{ value: BOOKMARK_ROOT, label: 'Bookmarks bar' }, ...top.filter((b) => b.kind === 'folder').map((f) => ({ value: f.id, label: f.title }))];
      if (found[0]) {
        existing = found[0];
        title = found[0].title;
        folder = found[0].parentId;
      }
    })().catch(() => undefined);
  });

  function close(): void {
    browser.bookmarkEditor = null;
  }

  async function save(): Promise<void> {
    const r = req;
    const lib = library();
    if (!r || !lib) return;
    busy = true;
    try {
      const name = title.trim() || displayUrl(r.url);
      if (existing) await lib.bookmarks.update(existing.id, { title: name, parentId: folder });
      else await lib.bookmarks.add({ parentId: folder, kind: 'bookmark', title: name, url: r.url });
      toast.success(existing ? 'Bookmark updated' : 'Bookmark added');
      close();
    } catch {
      toast.error('Could not save the bookmark', { description: 'Local storage is unavailable.' });
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    const lib = library();
    if (!existing || !lib) return;
    try {
      await lib.bookmarks.remove(existing.id);
      toast.success('Bookmark removed');
      close();
    } catch {
      toast.error('Could not remove the bookmark');
    }
  }
</script>

<Dialog open={req !== null} title={existing ? 'Edit bookmark' : 'Add bookmark'} description={req ? displayUrl(req.url) : undefined} size="sm" onclose={close} initialFocus="input">
  {#if !library()}
    <p class="muted">Bookmarks are not available in this browser session (local storage is unavailable).</p>
  {:else}
    <form
      class="form"
      onsubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <Field label="Name"><Input bind:value={title} maxlength={1024} /></Field>
      <Field label="Folder"><Select value={folder} options={folders} full onchange={(v) => (folder = v)} /></Field>
    </form>
  {/if}
  {#snippet footer()}
    {#if existing}<Button variant="ghost" icon={Trash2} onclick={() => void remove()}>Remove</Button>{/if}
    <span class="grow"></span>
    <Button variant="ghost" onclick={close}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!library()} onclick={() => void save()}>{existing ? 'Save' : 'Add bookmark'}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: var(--space-3);
  }

  .muted {
    color: var(--text-2);
  }

  .grow {
    flex: 1;
  }
</style>
