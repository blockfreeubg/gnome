<!-- A short list of sites (recently visited or favorites) with open / new tab / copy / remove actions. -->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import ListRow from '../../components/ListRow.svelte';
  import type { MenuItem } from '../../components/menu';
  import { openContextMenu } from '../../app/overlays/contextmenu.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { browseLink, openUrl } from '../../browser/bridge';
  import { formatRelativeTime } from '../../lib/format';
  import { displayUrl } from '../../lib/url';
  import type { SiteEntry } from './data';
  import Monogram from './Monogram.svelte';

  interface Props {
    entries: readonly SiteEntry[];
    label: string;
    showTime?: boolean;
    /** Extra menu items for an entry (e.g. remove from history). */
    extraItems?: (entry: SiteEntry) => MenuItem[];
  }

  let { entries, label, showTime = false, extraItems }: Props = $props();

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Address copied');
    } catch {
      toast.error('Could not copy', { description: 'Clipboard access was denied by the browser.' });
    }
  }

  function menu(entry: SiteEntry): MenuItem[] {
    const extra = extraItems?.(entry) ?? [];
    return [
      { label: 'Open', icon: ExternalLink, onSelect: () => void openUrl(entry.url) },
      { label: 'Open in new tab', onSelect: () => void openUrl(entry.url, { newTab: true }) },
      { label: 'Copy address', icon: Copy, onSelect: () => void copy(entry.url) },
      ...(extra.length ? [{ kind: 'separator' } as const, ...extra] : []),
    ];
  }
</script>

<ul class="sites" role="list" aria-label={label}>
  {#each entries as entry (entry.key)}
    <li>
      <ListRow
        title={entry.title}
        subtitle={displayUrl(entry.url)}
        meta={showTime ? formatRelativeTime(entry.time) : undefined}
        href={browseLink(entry.url)}
        oncontextmenu={(ev) => openContextMenu(ev, menu(entry), { label: entry.title })}
        onclick={(ev) => {
          if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
          ev.preventDefault();
          void openUrl(entry.url);
        }}
      >
        {#snippet leading()}<Monogram url={entry.url} title={entry.title} size={28} />{/snippet}
      </ListRow>
    </li>
  {/each}
</ul>

<style>
  .sites {
    margin: 0;
    padding: 0;
  }

  /* Compact 40px rows inside Home's glass panels: no dividers, a rounded hover tint. */
  .sites :global(.row) {
    min-height: 40px;
  }

  .sites :global(.main) {
    gap: 10px;
    margin: 0;
    padding: 5px 6px;
  }

  .sites :global(.title) {
    font-size: 0.9286rem;
    line-height: 1.3;
  }

  .sites :global(.subtitle) {
    font-size: var(--text-xs);
    line-height: 1.3;
  }

  .sites :global(.meta) {
    font-size: var(--text-xs);
    color: var(--text-3);
  }
</style>
