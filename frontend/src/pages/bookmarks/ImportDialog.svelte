<!--
  Import bookmarks from an HTML export (Chrome, Edge, Firefox, Safari): pick a file, see what it holds, import it
  into a new folder so nothing already here is touched.
-->
<script lang="ts">
  import FileUp from '@lucide/svelte/icons/file-up';
  import Button from '../../components/Button.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Input from '../../components/Input.svelte';
  import { formatNumber } from '../../lib/format';
  import type { BookmarkTreeNode, ImportOutcome } from '../../library/bookmarks';
  import { countTree, MAX_IMPORT_BYTES, parseNetscapeBookmarks } from '../../library/netscape';
  import { errorText, word } from '../../library/ui/view';

  interface Props {
    open: boolean;
    onimport: (nodes: BookmarkTreeNode[], folderTitle: string) => Promise<ImportOutcome>;
    onclose: () => void;
  }

  let { open = $bindable(), onimport, onclose }: Props = $props();

  let fileInput = $state<HTMLInputElement>();
  let fileName = $state<string | null>(null);
  // Raw: a parsed file can hold tens of thousands of nodes, which are read once (no deep reactivity needed).
  let nodes = $state.raw<BookmarkTreeNode[] | null>(null);
  let counts = $state<{ bookmarks: number; folders: number; webLinks: number; truncated: number } | null>(null);
  let folderTitle = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  $effect(() => {
    if (open) return;
    fileName = null;
    nodes = null;
    counts = null;
    error = null;
  });

  async function pick(): Promise<void> {
    const file = fileInput?.files?.[0];
    if (!file) return;
    error = null;
    nodes = null;
    counts = null;
    fileName = file.name;
    if (file.size > MAX_IMPORT_BYTES) {
      error = 'The file is larger than 16 MB.';
      return;
    }
    try {
      const parsed = parseNetscapeBookmarks(await file.text());
      const c = countTree(parsed.nodes);
      if (!c.bookmarks && !c.folders) {
        error = 'The file has no bookmarks.';
        return;
      }
      nodes = parsed.nodes;
      counts = { ...c, truncated: parsed.truncated };
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(Date.now());
      folderTitle = `Imported ${date}`;
    } catch (err) {
      error = errorText(err);
    }
  }

  async function run(): Promise<void> {
    if (!nodes) return;
    busy = true;
    try {
      await onimport(nodes, folderTitle.trim() || 'Imported');
      open = false;
      onclose();
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Import bookmarks" description="Choose a bookmarks file exported from another browser (HTML). It is imported into a new folder." size="md" {onclose}>
  <div class="body">
    <input bind:this={fileInput} class="file" type="file" accept=".html,.htm,text/html" onchange={pick} aria-label="Bookmarks file" />
    <div class="picker">
      <Button variant="secondary" icon={FileUp} onclick={() => fileInput?.click()}>{fileName ? 'Choose another file' : 'Choose file…'}</Button>
      {#if fileName}<span class="name" title={fileName}>{fileName}</span>{/if}
    </div>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {:else if counts}
      <p class="summary">
        {formatNumber(counts.bookmarks)} {word(counts.bookmarks, 'bookmark')} in {formatNumber(counts.folders)} {word(counts.folders, 'folder')}.
        {#if counts.bookmarks > counts.webLinks}
          {formatNumber(counts.bookmarks - counts.webLinks)} {counts.bookmarks - counts.webLinks === 1 ? 'is' : 'are'} not a web address (bookmarklets, browser pages) and will be skipped.
        {/if}
        {#if counts.truncated}
          The file has {formatNumber(counts.truncated)} more {word(counts.truncated, 'entry', 'entries')} than GNOME reads from one file; they are skipped.
        {/if}
      </p>
      <Field label="Folder name">
        <Input bind:value={folderTitle} size="lg" maxlength={512} />
      </Field>
    {/if}
    <p class="hint">In Chrome or Edge: Bookmarks manager → ⋮ → Export bookmarks. In Firefox: Bookmarks → Manage bookmarks → Import and Backup → Export Bookmarks to HTML.</p>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!nodes || !counts?.webLinks} onclick={run}>Import</Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .file {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .picker {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .summary,
  .error,
  .hint {
    margin: 0;
  }

  .error {
    color: var(--danger);
  }

  .hint {
    color: var(--text-3);
    font-size: var(--text-sm);
  }
</style>
