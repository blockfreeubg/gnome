<!--
  The cookie manager (WAVE-B3 §7.1): the cookies of sites opened in GNOME, as the engine host lists them
  (`cookies.list`, capability `cookies`: both engines' jars, never the values), grouped by registrable domain
  (core/site.ts `siteOf`, private suffixes included), with names, size, expiry and flags. Delete one cookie (by its
  domain and name: same-named cookies of that domain's subdomains go with it), a site's cookies, or every cookie.
-->
<script lang="ts">
  import Cookie from '@lucide/svelte/icons/cookie';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Button from '../../../components/Button.svelte';
  import EmptyState from '../../../components/EmptyState.svelte';
  import IconButton from '../../../components/IconButton.svelte';
  import SearchInput from '../../../components/SearchInput.svelte';
  import Skeleton from '../../../components/Skeleton.svelte';
  import Tag from '../../../components/Tag.svelte';
  import { toast } from '../../../app/overlays/toast.svelte';
  import { formatBytes, formatDateTime, pluralize } from '../../../lib/format';
  import type { CookieInfo } from '../../../shared/engine-protocol';
  import { browser, engineLabel } from '../../../browser/browser.svelte';
  import { siteOf } from '../../core/site';

  const available = $derived(browser.hasCapability('cookies'));
  let cookies = $state<CookieInfo[] | null>(null);
  let truncated = $state(false);
  let loading = $state(false);
  let failed = $state(false);
  let filter = $state('');

  const bare = (domain: string): string => domain.replace(/^\./, '').toLowerCase();
  const siteOfDomain = (domain: string): string => siteOf(`http://${bare(domain)}/`) ?? bare(domain);

  async function load(): Promise<void> {
    if (!available) return;
    loading = true;
    failed = false;
    try {
      const r = await browser.listCookies(null);
      cookies = r.cookies;
      truncated = r.truncated;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (available && cookies === null && !loading) void load();
  });

  const groups = $derived.by(() => {
    const by = new Map<string, CookieInfo[]>();
    for (const c of cookies ?? []) {
      const s = siteOfDomain(c.domain);
      by.set(s, [...(by.get(s) ?? []), c]);
    }
    const q = filter.trim().toLowerCase();
    return [...by.entries()]
      .filter(([s]) => !q || s.includes(q))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([site, list]) => ({ site, list: list.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name)) }));
  });

  async function remove(p: { all: boolean; site: string | null; name: string | null }, what: string): Promise<void> {
    try {
      const r = await browser.deleteCookies(p);
      toast.success(`${what}: ${pluralize(r.deleted, 'cookie')} deleted`);
    } catch {
      toast.error('Cookies could not be deleted', { description: 'The browser engine did not answer.' });
    }
    await load();
  }

  async function removeAll(): Promise<void> {
    const { confirm } = await import('../../../app/overlays/dialogs.svelte');
    const ok = await confirm({
      title: 'Delete every cookie?',
      message: 'Cookies of every site opened in GNOME are deleted, in both engines. Signs you out of most sites.',
      confirmLabel: 'Delete cookies',
      danger: true,
    });
    if (ok) await remove({ all: true, site: null, name: null }, 'All sites');
  }

  function flags(c: CookieInfo): string[] {
    const f: string[] = [];
    if (c.secure) f.push('Secure');
    if (c.httpOnly) f.push('HttpOnly');
    if (c.sameSite) f.push(`SameSite=${c.sameSite[0]!.toUpperCase()}${c.sameSite.slice(1)}`);
    return f;
  }
</script>

<div class="cookies" data-cookie-manager>
  {#if !available}
    <p class="msg">The cookie list appears once GNOME’s browser is running: open a page in the browser first.</p>
  {:else if cookies === null && (loading || !failed)}
    <Skeleton lines={4} />
  {:else if failed && cookies === null}
    <div class="msg row">
      <span>The browser engine did not answer.</span>
      <Button size="sm" variant="ghost" icon={RefreshCw} onclick={() => void load()}>Try again</Button>
    </div>
  {:else if cookies && cookies.length === 0}
    <EmptyState icon={Cookie} title="No cookies" description="Sites you open in GNOME have no cookies stored right now." />
  {:else if cookies}
    <div class="bar">
      <SearchInput bind:value={filter} placeholder="Filter by site" label="Filter cookies by site" size="sm" />
      <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onclick={() => void load()}>Refresh</Button>
      <Button size="sm" variant="danger" icon={Trash2} onclick={() => void removeAll()}>Delete all</Button>
    </div>
    <p class="msg">
      {pluralize(cookies.length, 'cookie')} from {pluralize(groups.length, 'site')}{truncated ? ' (the list was cut short: delete some to see the rest)' : ''}. Values are never shown.
    </p>
    {#each groups as g (g.site)}
      <section class="site" data-cookie-site={g.site}>
        <header>
          <h4 class="mono">{g.site}</h4>
          <span class="count">{g.list.length}</span>
          <Button size="sm" variant="ghost" icon={Trash2} onclick={() => void remove({ all: false, site: g.site, name: null }, g.site)}>Delete site’s cookies</Button>
        </header>
        <ul>
          {#each g.list as c (`${c.engine}|${c.domain}|${c.path}|${c.name}`)}
            <li>
              <div class="info">
                <span class="name mono">{c.name}</span>
                <span class="meta">
                  {bare(c.domain)}{c.path !== '/' ? c.path : ''} · {formatBytes(c.size)} · {c.expires === null ? 'until the browser closes' : `expires ${formatDateTime(c.expires)}`}
                </span>
                <span class="tags">
                  <Tag tone="neutral">{engineLabel(c.engine)}</Tag>
                  {#each flags(c) as f (f)}<Tag tone="neutral">{f}</Tag>{/each}
                </span>
              </div>
              <IconButton icon={Trash2} label="Delete cookie {c.name} of {bare(c.domain)}" size="sm" onclick={() => void remove({ all: false, site: bare(c.domain), name: c.name }, c.name)} />
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .cookies {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .msg {
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .row,
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .bar > :global(:first-child) {
    flex: 1;
    min-width: 12rem;
  }

  .site {
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--hairline);
  }

  h4 {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .count {
    font-size: var(--text-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  }

  li + li {
    border-top: 1px solid var(--hairline);
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .name {
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .meta {
    font-size: var(--text-xs);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
