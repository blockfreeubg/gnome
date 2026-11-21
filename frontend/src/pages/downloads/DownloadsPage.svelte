<!--
  Downloads: the files the browser downloaded from pages opened in GNOME, newest first, grouped by day, with live
  progress (persisted about once a second), state, size and source. The browser's own download manager has the files:
  GNOME cannot open, pause or cancel them, and says so. Actions: download again (through the proxy), copy the
  address, open the site, remove from the list, clear finished ones.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import Ellipsis from '@lucide/svelte/icons/ellipsis-vertical';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import File from '@lucide/svelte/icons/file';
  import FileArchive from '@lucide/svelte/icons/file-archive';
  import FileCode from '@lucide/svelte/icons/file-code';
  import FileImage from '@lucide/svelte/icons/file-image';
  import FileMusic from '@lucide/svelte/icons/file-music';
  import FilePlay from '@lucide/svelte/icons/file-play';
  import FileText from '@lucide/svelte/icons/file-text';
  import Info from '@lucide/svelte/icons/info';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Search from '@lucide/svelte/icons/search';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import type { LucideIcon } from '@lucide/svelte';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import ProgressBar from '../../components/ProgressBar.svelte';
  import SearchInput from '../../components/SearchInput.svelte';
  import Skeleton from '../../components/Skeleton.svelte';
  import Tag from '../../components/Tag.svelte';
  import type { MenuItem } from '../../components/menu';
  import { openContextMenu } from '../../app/overlays/contextmenu.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import type { PageProps } from '../../app/routes';
  import { openUrl } from '../../browser/bridge';
  import { formatNumber } from '../../lib/format';
  import { initLibrary, localLibrary } from '../../library/index';
  import Notice from '../../library/ui/Notice.svelte';
  import { copyText, downloadMatches, downloadSize, errorText, fileKind, formatClock, groupByDay, hostname, STATE_LABEL, type FileKind, word } from '../../library/ui/view';
  import type { DownloadItem } from '../../shared/browser-data';
  import { settings } from '../../settings/store.svelte';

  let {}: PageProps = $props();

  initLibrary();
  const lib = localLibrary()!;
  const LIMIT = 1000;

  // Raw: replaced as a whole on every load (up to 1000 items; no deep proxies needed).
  let items = $state.raw<DownloadItem[]>([]);
  let loading = $state(true);
  let failed = $state<string | null>(null);
  let text = $state('');

  const tracking = $derived(settings.value.browser.downloads.track);
  const keepDays = $derived(settings.value.browser.downloads.keepDays);
  const shown = $derived(text.trim() ? items.filter((d) => downloadMatches(d, text)) : items);
  const groups = $derived(groupByDay(shown, (d) => d.startedAt));
  const finished = $derived(items.filter((d) => d.state !== 'in_progress').length);
  const running = $derived(items.length - finished);

  const ICONS: Record<FileKind, LucideIcon> = {
    archive: FileArchive,
    image: FileImage,
    video: FilePlay,
    audio: FileMusic,
    document: FileText,
    code: FileCode,
    file: File,
  };

  async function load(): Promise<void> {
    try {
      items = await lib.downloads.list(LIMIT);
      failed = null;
    } catch (err) {
      failed = errorText(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = lib.downloads.onChange(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        void load();
      }, 100);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  });

  async function remove(d: DownloadItem): Promise<void> {
    try {
      await lib.downloads.remove(d.id);
      toast.success('Removed from the list', { description: d.state === 'in_progress' ? 'The browser keeps downloading it.' : d.filename });
    } catch (err) {
      toast.error('Could not update the list', { description: errorText(err) });
    }
  }

  async function clearFinished(): Promise<void> {
    try {
      await lib.downloads.clear();
      toast.success('Downloads list cleared', { description: running ? 'Downloads still running stay in the list.' : 'Downloaded files are not deleted.' });
    } catch (err) {
      toast.error('Could not clear the list', { description: errorText(err) });
    }
  }

  function origin(url: string): string | null {
    try {
      return new URL(url).origin + '/';
    } catch {
      return null;
    }
  }

  function menu(d: DownloadItem): MenuItem[] {
    const site = origin(d.url);
    return [
      { label: 'Download again', icon: RotateCcw, onSelect: () => void openUrl(d.url, { newTab: true, background: true }) },
      { label: 'Copy download address', icon: Copy, onSelect: async () => ((await copyText(d.url)) ? toast.success('Address copied') : toast.error('Could not copy', { description: 'Clipboard access was denied by the browser.' })) },
      ...(site ? [{ label: `Open ${hostname(d.url)}`, icon: ExternalLink, onSelect: () => void openUrl(site) }] : []),
      { kind: 'separator' },
      { label: 'Remove from list', icon: X, onSelect: () => void remove(d) },
    ];
  }

  function percent(d: DownloadItem): number | null {
    return d.total && d.total > 0 ? Math.min(1, d.received / d.total) : null;
  }

  const tone = (s: DownloadItem['state']): 'danger' | 'warning' | 'neutral' | 'moss' =>
    s === 'failed' ? 'danger' : s === 'cancelled' ? 'warning' : s === 'completed' ? 'moss' : 'neutral';
</script>

<div class="page narrow library">
  <PageHeader title="Downloads" description="Files saved from pages you browse in GNOME. Your browser keeps the files; this is GNOME's list of them.">
    {#snippet actions()}
      <Button variant="outline" icon={Trash2} disabled={!finished} onclick={clearFinished}>Clear list</Button>
    {/snippet}
  </PageHeader>

  {#if !tracking}
    <Notice icon={Download} title="The downloads list is off">
      Files still download, but GNOME doesn’t list new ones.
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => settings.set('browser', 'downloads', { ...settings.value.browser.downloads, track: true })}>Turn on</Button>
      {/snippet}
    </Notice>
  {/if}

  {#if failed}
    <Notice icon={TriangleAlert} tone="danger" title="The downloads list is unavailable">
      {failed}
      {#snippet actions()}<Button size="sm" variant="secondary" onclick={load}>Try again</Button>{/snippet}
    </Notice>
  {/if}

  {#if items.length}
    <div class="toolbar">
      <SearchInput bind:value={text} label="Filter downloads" placeholder="Filter by name or address" class="search" />
      <p class="summary" aria-live="polite">
        {#if running}<span class="live">{formatNumber(running)} running</span> ·{/if}
        {formatNumber(items.length)} {word(items.length, 'download')}
      </p>
    </div>
  {/if}

  {#if loading || items.length || !failed}
  <div class="card">
    {#if loading}
      <div class="skeleton" aria-hidden="true">{#each [0, 1, 2, 3] as i (i)}<Skeleton height="56px" />{/each}</div>
    {:else if !items.length && !failed}
      <EmptyState icon={Download} title="No downloads" description="Files you download while browsing are listed here with their progress, size and source." />
    {:else if !shown.length}
      <EmptyState icon={Search} title="No matches" description={`No download matches “${text.trim()}”.`} size="sm" />
    {:else}
      <div class="days">
        {#each groups as g (g.key)}
          <section aria-labelledby="dl-{g.key}">
            <h2 id="dl-{g.key}" class="eyebrow day">{g.label}</h2>
            <ul role="list">
              {#each g.items as d (d.id)}
                {@const Icon = ICONS[fileKind(d.filename, d.mime)]}
                {@const p = percent(d)}
                <li class="row" class:muted={d.state === 'untracked' || d.state === 'cancelled'} oncontextmenu={(e) => openContextMenu(e, menu(d), { label: d.filename })}>
                  <span class="icon" class:failed={d.state === 'failed'} aria-hidden="true"><Icon size={18} strokeWidth={1.75} /></span>
                  <div class="text">
                    <div class="line">
                      <span class="name" title={d.filename}>{d.filename}</span>
                      {#if d.state !== 'in_progress'}
                        <Tag tone={tone(d.state)}>{STATE_LABEL[d.state]}</Tag>
                      {/if}
                    </div>
                    <div class="meta">
                      <span class="host">{hostname(d.url)}</span>
                      {#if downloadSize(d)}<span aria-hidden="true">·</span><span class="size">{downloadSize(d)}</span>{/if}
                      <span aria-hidden="true">·</span>
                      <time datetime={new Date(d.startedAt).toISOString()}>{formatClock(d.startedAt)}</time>
                      <span class="engine" title={d.engine === 'scramjet' ? 'Scramjet' : 'Ultraviolet'}>{d.engine === 'scramjet' ? 'SJ' : 'UV'}</span>
                    </div>
                    {#if d.state === 'in_progress'}
                      <ProgressBar
                        value={p}
                        label="Download progress of {d.filename}"
                        valueText={p === null ? `${downloadSize(d)}` : `${Math.round(p * 100)} %, ${downloadSize(d)}`}
                        size="xs"
                        class="bar"
                      />
                    {:else if d.state === 'failed' && d.error}
                      <p class="note error">{d.error}</p>
                    {:else if d.state === 'untracked'}
                      <p class="note">GNOME was reloaded while this ran; your browser’s own downloads list has the outcome.</p>
                    {/if}
                  </div>
                  <IconButton icon={Ellipsis} size="sm" label="Actions for {d.filename}" tooltip={false} onclick={(e) => openContextMenu(e, menu(d), { label: d.filename })} />
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  </div>
  {/if}

  <aside class="about">
    <Info size={16} strokeWidth={1.75} aria-hidden="true" />
    <p>
      Downloads go to your browser’s download folder. To open, pause or cancel one, use your browser’s own downloads list.
      Files a page creates itself (for example exports generated in the page) are not listed.
      {#if tracking}{keepDays > 0 ? `Finished downloads stay in this list for ${keepDays} ${word(keepDays, 'day')}.` : 'Finished downloads stay in this list until you clear it.'}{/if}
    </p>
  </aside>
</div>

<style>
  .library {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-top: var(--space-2);
  }

  .toolbar :global(.search) {
    flex: 1;
    max-width: 560px;
  }

  .summary {
    margin: 0 0 0 auto;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .live {
    color: var(--text);
    font-weight: 600;
  }

  /* The list sits in one glass card (DESIGN.md §12); rows are separated by hairlines. */
  .card {
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
  }

  .days {
    display: flex;
    flex-direction: column;
    padding-bottom: var(--space-2);
  }

  .days > section + section {
    border-top: 1px solid var(--hairline);
  }

  .day {
    position: sticky;
    top: 0;
    z-index: 2;
    margin: 0;
    padding: var(--space-4) var(--space-4) var(--space-2);
    background: var(--glass-bg-card);
  }

  .days > section:first-child .day {
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  }

  ul {
    margin: 0;
    padding: 0 var(--space-2);
    list-style: none;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-2);
    border-radius: var(--radius);
    transition: background-color var(--t-1) var(--ease-out);
  }

  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: calc(var(--space-2) + 36px + var(--space-3));
    right: var(--space-2);
    height: 1px;
    background: var(--hairline);
  }

  .row:hover,
  .row:focus-within {
    background: var(--hover);
  }

  .row:hover::before,
  .row:focus-within::before,
  .row:hover + .row::before,
  .row:focus-within + .row::before {
    opacity: 0;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    align-self: flex-start;
    border-radius: var(--radius);
    color: var(--text-2);
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }

  .icon.failed {
    color: var(--danger);
    background: var(--danger-soft);
  }

  .muted .name,
  .muted .icon {
    opacity: 0.7;
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-wrap: wrap;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .engine {
    margin-left: var(--space-1);
    padding: 0 5px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--text-3);
  }

  .text :global(.bar) {
    margin-top: var(--space-1);
    max-width: 520px;
  }

  .note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  .note.error {
    color: var(--danger);
  }

  .about {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding: 0 var(--space-2);
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: 1.55;
  }

  .about :global(svg) {
    flex: none;
    margin-top: 2px;
  }

  .about p {
    margin: 0;
    max-width: 78ch;
  }

  @media (max-width: 759px) {
    .toolbar {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
    }

    .toolbar :global(.search) {
      flex: none;
      max-width: none;
    }

    .summary {
      margin: 0;
    }

    .day {
      padding: var(--space-3) var(--space-3) var(--space-2);
    }

    ul {
      padding: 0 var(--space-1);
    }

    /* Narrow rows: the state tag moves under a long file name instead of squeezing it to a few characters. */
    .line {
      flex-wrap: wrap;
      row-gap: 3px;
    }

    .name {
      max-width: 100%;
    }
  }
</style>
