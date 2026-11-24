<!--
  GNOME's error page over the content area (ENGINE-PROTOCOL §6.4), never an engine's: what failed, Retry and, when
  the other engine is ready and was not tried, "Open with <other engine>". Restored from tab.state after a missed
  event. Strings from the engine host are shown as text.

  A page the content blocker stopped (kind `blocked`, WAVE-B3 §7.1) gets GNOME's own reason for its category
  (`detail` = `blocked:<category>`, never shown raw), "Go back" (the tab's current page: the blocked navigation never
  committed) and never the engine-fallback button (the other engine would block it too). For the scam and malware
  list there is no one-click allow, only the way to Settings → Site rules: a forged or mistaken prompt must not become
  a permanent, synced bypass. For other categories, "Turn off blocking on <key>" opens a confirmation in GNOME's UI
  that shows the key and what it turns off; after Confirm the tab loads the blocked address.
-->
<script lang="ts">
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import ServerCrash from '@lucide/svelte/icons/server-crash';
  import ShieldBan from '@lucide/svelte/icons/shield-ban';
  import Timer from '@lucide/svelte/icons/timer';
  import Unplug from '@lucide/svelte/icons/unplug';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Button from '../../components/Button.svelte';
  import { navigate } from '../../app/router.svelte';
  import Icon from '../../components/Icon.svelte';
  import { hostOf } from '../../lib/url';
  import { server } from '../../app/server.svelte';
  import { settings } from '../../settings/store.svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import { browser, engineLabel, otherEngine } from '../browser.svelte';
  import type { Tab, TabError } from '../tabs.svelte';
  import { blockedCategory, errorCopy, type ErrorGlyph } from './error-copy';
  import { vpnState } from '../../vpn/state.svelte';

  let { tab, error }: { tab: Tab; error: TabError } = $props();

  const host = $derived(error.url ? hostOf(error.url) : tab.url ? hostOf(tab.url) : '');
  // The route the app chose and what /api/vpn/locations says about it (ENGINE-PROTOCOL §6.4): "VPN location down"
  // comes from the app's own facts, never from the engine host's words.
  const vpn = $derived(browser.vpnLocation);
  const killSwitch = $derived(settings.value.vpn.killSwitch);

  const GLYPHS: Record<ErrorGlyph, LucideIcon> = { unplug: Unplug, timer: Timer, server: ServerCrash, offline: CloudOff, blocked: ShieldBan };
  const copy = $derived.by(() => {
    // The server's last exit check of this location failed (a warning, D14): one more line, never a verdict.
    const exitFails = vpn !== null && vpn.id !== '' && vpnState().exitWarning(vpn.id) !== null;
    const c = errorCopy(error, { host, vpn, killSwitch, engine: engineLabel(error.engine), exitFails });
    return { ...c, icon: GLYPHS[c.glyph] };
  });

  const other = $derived(otherEngine(error.engine));
  const blocked = $derived(error.kind === 'blocked');
  const category = $derived(blocked ? blockedCategory(error.detail) : null);
  const otherReady = $derived(!blocked && error.fallback === 'available' && server.config?.engines[other] !== false);

  // The key "Turn off blocking on <key>" writes (core/site.ts, loaded only for a blocked page: tldts stays out of the
  // app's first chunk). None for the scam and malware list.
  let allowKey = $state<string | null>(null);
  $effect(() => {
    const url = error.url;
    allowKey = null;
    if (!blocked || category === 'security' || !url) return;
    let live = true;
    void Promise.all([import('../../extensions/core/site'), import('../../extensions/app/shield')]).then(([site, shield]) => {
      if (live) allowKey = shield.blockedPageKey(url, site);
    });
    return () => {
      live = false;
    };
  });

  /** Back to the page the tab shows (the blocked navigation never committed), or one entry back, or close the tab. */
  function goBack(): void {
    if (tab.url && tab.url !== error.url) browser.reload(tab.id);
    else if (tab.canGoBack) browser.go(-1, tab.id);
    else browser.close(tab.id);
  }
  const backLabel = $derived(tab.url && tab.url !== error.url ? 'Go back' : tab.canGoBack ? 'Go back' : 'Close tab');

  async function turnOff(): Promise<void> {
    const key = allowKey;
    if (!key) return;
    const { confirm } = await import('../../app/overlays/dialogs.svelte');
    // The tab then loads the address with tab.navigate (a GET): a form is not sent again, so the dialog says that.
    const form = error.idempotent ? '' : ' The blocked page was the answer to a form: it loads again without sending the form.';
    const ok = await confirm({
      title: `Turn off blocking on ${key}?`,
      message: `Ad and tracker blocking, cosmetic filtering and tracking-parameter removal will be off on ${key}, also on your other devices if you sync settings. You can undo it in Settings → Extensions → Allowed sites.${form}`,
      confirmLabel: 'Turn off blocking',
    });
    if (ok) browser.allowBlockedPage(tab.id, key);
  }
</script>

<div class="overlay" role="alert" aria-live="assertive">
  <div class="card glass-card">
    <span class="glyph"><Icon icon={copy.icon} size={26} /></span>
    <h2 class="title">{copy.title}</h2>
    <p class="body">{copy.body}</p>
    {#if blocked}
      {#if error.url}<p class="detail mono" title="The blocked address">{error.url}</p>{/if}
      {#if category === 'security'}
        <p class="body">If you are sure, you can allow the site under <a href="/settings/extensions#allowlist" onclick={(ev) => { ev.preventDefault(); void navigate('/settings/extensions#allowlist'); }}>Settings → Site rules</a>.</p>
      {/if}
      <div class="actions">
        <Button variant="primary" icon={ArrowLeft} onclick={goBack}>{backLabel}</Button>
        {#if allowKey}
          <Button onclick={() => void turnOff()}>Turn off blocking on <span class="mono key">{allowKey}</span></Button>
        {/if}
      </div>
    {:else}
      {#if !error.idempotent}
        <p class="warn">This page was the answer to a form. Retrying loads the address again without sending the form.</p>
      {/if}
      {#if copy.exitLine}
        <p class="body">{copy.exitLine}</p>
      {/if}
      {#if error.detail}
        <p class="detail mono" title="What the transport reported">{error.detail}</p>
      {/if}
      <div class="actions">
        <Button variant="primary" icon={RotateCw} onclick={() => browser.retry(tab.id)}>Retry</Button>
        {#if otherReady}
          <Button onclick={() => browser.retry(tab.id, other)}>Open with {engineLabel(other)}</Button>
        {/if}
        {#if copy.vpnLink}
          <Button onclick={() => void navigate('/vpn')}>Open VPN page</Button>
        {/if}
      </div>
    {/if}
    <p class="meta">
      {engineLabel(error.engine)}{error.fallback === 'attempted' ? ` after ${engineLabel(other)} failed` : ''}{error.latencyMs ? ` · ${error.latencyMs < 1000 ? `${error.latencyMs} ms` : `${(error.latencyMs / 1000).toFixed(1)} s`}` : ''}
    </p>
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--space-8) var(--space-6);
    background: var(--bg);
    overflow: auto;
    z-index: 2;
  }

  /* An ivy card (DESIGN.md §11.7): glass, 24px radius, big soft shadow. */
  .card {
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 32px 28px 26px;
  }

  .glyph {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: var(--space-2);
    border-radius: var(--radius-lg);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text);
  }

  .title {
    font-family: var(--font-display);
    font-size: 1.6rem;
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -0.03em;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .body {
    color: var(--text-2);
    font-size: 0.9286rem;
    line-height: 1.6;
  }

  .warn {
    color: var(--warning);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .detail {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    background: var(--field-bg);
    border: 1px solid var(--field-border);
    color: var(--text-3);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-direction: column;
    align-self: stretch;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .actions :global(.btn) {
    width: 100%;
    height: var(--control-h-lg);
    border-radius: var(--radius-lg);
  }

  .key {
    margin-left: 0.3em;
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .body a {
    color: var(--accent);
  }

  .meta {
    align-self: stretch;
    margin-top: var(--space-1);
    color: var(--text-3);
    font-size: var(--text-xs);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 759px) {
    .card {
      padding: 24px 20px;
    }
  }
</style>
