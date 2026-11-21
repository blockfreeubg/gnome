<!--
  Downloads panel (ENGINE-PROTOCOL §6.9): the newest downloads GNOME observed, with streamed progress. The browser's
  own download manager saves the files, so GNOME cannot pause or cancel them; the full list is the Downloads page.
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import FileDown from '@lucide/svelte/icons/file-down';
  import Button from '../../components/Button.svelte';
  import Icon from '../../components/Icon.svelte';
  import Popover from '../../components/Popover.svelte';
  import ProgressBar from '../../components/ProgressBar.svelte';
  import { navigate } from '../../app/router.svelte';
  import { formatBytes, formatRelativeTime } from '../../lib/format';
  import { settings } from '../../settings/store.svelte';
  import { onLibrary, type DownloadItem } from '../../shared/browser-data';
  import { browser } from '../browser.svelte';

  let { anchor }: { anchor: HTMLElement | undefined } = $props();
  let items = $state.raw<DownloadItem[]>([]);
  let loaded = $state(false);

  $effect(() => {
    let off: (() => void) | null = null;
    const stop = onLibrary((lib) => {
      off?.();
      off = null;
      if (!lib) return;
      const load = (): void =>
        void lib.downloads
          .list(8)
          .then((l) => {
            items = l;
            loaded = true;
          })
          .catch(() => (loaded = true));
      load();
      off = lib.downloads.onChange(load);
    });
    return () => {
      stop();
      off?.();
    };
  });

  function sizeText(d: DownloadItem): string {
    if (d.state === 'in_progress') return d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
    if (d.state === 'completed') return formatBytes(d.total ?? d.received);
    if (d.state === 'untracked') return 'Finished outside GNOME’s view (see your browser’s downloads)';
    if (d.state === 'cancelled') return 'Cancelled';
    return d.error ? `Failed: ${d.error}` : 'Failed';
  }
</script>

<Popover class="browser-pop" bind:open={browser.downloadsOpen} {anchor} label="Downloads" placement="bottom-end" width="360px">
  <div class="panel">
    <div class="head">
      <h3 class="eyebrow">Downloads</h3>
      <Button size="sm" variant="ghost" onclick={() => {
        browser.downloadsOpen = false;
        void navigate('/downloads');
      }}>Show all</Button>
    </div>
    {#if !settings.value.browser.downloads.track}
      <p class="empty">Keeping a downloads list is turned off. Files still download as usual.</p>
    {:else if loaded && items.length === 0}
      <p class="empty">No downloads yet. Files you download from pages opened in GNOME appear here.</p>
    {:else}
      <ul role="list">
        {#each items as d (d.id)}
          <li>
            <span class="glyph" class:bad={d.state === 'failed' || d.state === 'cancelled'}>
              <Icon icon={d.state === 'completed' ? CircleCheck : d.state === 'failed' || d.state === 'cancelled' ? CircleAlert : FileDown} size={16} />
            </span>
            <span class="text">
              <span class="name" title={d.filename}>{d.filename}</span>
              {#if d.state === 'in_progress'}
                <ProgressBar value={d.total ? d.received : null} max={d.total ?? 100} label={`Downloading ${d.filename}`} size="xs" />
              {/if}
              <span class="meta">{sizeText(d)} · {formatRelativeTime(d.finishedAt ?? d.startedAt)}</span>
            </span>
          </li>
        {/each}
      </ul>
      <p class="note">Your browser saves these files; GNOME cannot pause or cancel them.</p>
    {/if}
  </div>
</Popover>

<style>
  .panel {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 var(--space-2) var(--space-1);
  }

  ul {
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }

  li {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-1);
    border-bottom: 1px solid var(--hairline);
  }

  .glyph {
    flex: none;
    margin-top: 2px;
    color: var(--text-2);
  }

  .glyph.bad {
    color: var(--danger);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--text);
  }

  .meta {
    color: var(--text-3);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .empty,
  .note {
    padding: var(--space-3) var(--space-1) var(--space-1);
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .note {
    font-size: var(--text-xs);
  }
</style>
