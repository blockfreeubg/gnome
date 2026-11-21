<!--
  The shield's panel (WAVE-B3 §7.1), opened by a click in GNOME's UI: this page's counts per category, the blocker's
  state in GNOME's own words, Pause on this site / Resume (each names its key), the three per-site switches, "Reload
  to apply" after a change, and a link to the Extensions page. Site keys come from core/site.ts (tldts, private
  suffixes: `foo.github.io` is its own site). Every change is a settings change the user makes here; the page is then
  exposed as GNOME's own load (D5) so the next load is judged with the new rule.
-->
<script lang="ts">
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Button from '../../components/Button.svelte';
  import Popover from '../../components/Popover.svelte';
  import Switch from '../../components/Switch.svelte';
  import { navigate } from '../../app/router.svelte';
  import { siteKeyOf, siteOf } from '../../extensions/core/site';
  import { pauseAllowlist, resumeAllowlist, setSiteSwitch, shieldSite, SITE_SWITCHES, type SiteSwitch } from '../../extensions/app/shield';
  import { BLOCKER_CATEGORIES } from '../../extensions/app/stats.svelte';
  import { hostOf } from '../../lib/url';
  import { settings } from '../../settings/store.svelte';
  import { browser } from '../browser.svelte';
  import type { Tab } from '../tabs.svelte';
  import { BLOCK_CATEGORY_LABELS, blockerStateCopy } from './error-copy';

  let { open = $bindable(false), anchor, tab }: { open: boolean; anchor: HTMLElement | undefined; tab: Tab } = $props();

  const fns = { siteOf, siteKeyOf };
  const ext = $derived(settings.value.extensions);
  const top = $derived(tab.url ?? '');
  const host = $derived(top ? hostOf(top) : '');
  const site = $derived(top ? shieldSite(top, ext, fns) : null);
  const stateCopy = $derived(browser.status?.blocker ? blockerStateCopy(browser.status.blocker) : null);
  const rows = $derived(BLOCKER_CATEGORIES.map((c) => ({ c, label: BLOCK_CATEGORY_LABELS[c], n: tab.blockedBy[c] ?? 0 })).filter((r) => r.n > 0));
  const direct = $derived(tab.blockedBy['direct-connection'] ?? 0);
  /** A rule changed from this panel since it opened: the page shows it after a reload. */
  let changed = $state(false);
  /**
   * The tab shows GNOME's blocked page (WAVE-B3 §7.1): what the user can do there is on that page (Go back; for other
   * lists than the scam and malware list, a confirmation that names its key and says it syncs). The panel offers no
   * Pause and no per-site switches meanwhile: in a tab whose first page was blocked they would allow that very site
   * with one click, also a scam and malware site, which the blocked page deliberately does not offer (§11.1).
   */
  const blockedPage = $derived(tab.error?.kind === 'blocked');

  const SWITCH_LABELS: Record<SiteSwitch, { label: string; hint: string }> = {
    adblock: { label: 'Ads', hint: 'Ad blocker and the scam and malware list' },
    trackers: { label: 'Trackers', hint: 'Tracker blocker' },
    cosmetic: { label: 'Cosmetic filtering', hint: 'Hides ad frames and page clutter' },
  };

  function apply(): void {
    changed = true;
    browser.applySiteRules(top, tab.id);
  }

  function pause(): void {
    if (!site?.pauseKey) return;
    settings.set('extensions', 'allowlist', pauseAllowlist(ext.allowlist, site.pauseKey));
    apply();
  }

  function resume(): void {
    if (!site) return;
    settings.set('extensions', 'allowlist', resumeAllowlist(ext.allowlist, site.removable));
    apply();
  }

  function toggle(which: SiteSwitch, on: boolean): void {
    if (!site) return;
    const next = setSiteSwitch(ext, site, which, on);
    if (!next) return;
    settings.set('extensions', 'perSite', next);
    apply();
  }

  function reload(): void {
    changed = false;
    open = false;
    browser.reload(tab.id);
  }
</script>

<Popover class="browser-pop" bind:open {anchor} label="Content blocking" placement="bottom-end" width="340px" onclose={() => (changed = false)}>
  <div class="panel" data-shield-panel>
    <div class="head">
      <h3 class="title">Content blocking</h3>
      <p class="site mono" title={host}>{host || 'This page'}</p>
    </div>

    {#if browser.siteRulesPaused}
      <p class="note warn" role="status">Site rules are paused on this page: GNOME noticed tampering in its browser engine. Reload GNOME to resume them.</p>
    {/if}

    {#if site?.allowlisted}
      <p class="note">Blocking is paused on this site: filter lists, cosmetic filtering and tracking-parameter removal are off here. Privacy headers and cookie rules still apply.</p>
    {:else if rows.length}
      <ul class="counts" aria-label="Blocked on this page">
        {#each rows as r (r.c)}
          <li><span>{r.label}</span><span class="n">{r.n}</span></li>
        {/each}
      </ul>
    {:else}
      <p class="note">Nothing blocked on this page so far.</p>
    {/if}
    {#if direct > 0}
      <p class="direct"><span>{BLOCK_CATEGORY_LABELS['direct-connection']}</span><span class="n">{direct}</span></p>
      <p class="hint">GNOME’s sandbox stops these whether or not blocking is on.</p>
    {/if}

    {#if stateCopy && stateCopy.text}
      <p class="note" class:warn={stateCopy.tone === "warn"} class:error={stateCopy.tone === "error"} data-blocker-state={browser.status?.blocker.state}>{stateCopy.text}</p>
    {/if}

    {#if blockedPage}
      <p class="note" data-shield-blocked-page>GNOME blocked this page. What you can do about it is on the page itself.</p>
    {:else if site}
      <div class="actions">
        {#if site.allowlisted && site.broader}
          <p class="note">
            Blocking is off for <span class="mono">{site.broader}</span> in Settings.
            <a href="/settings/extensions#allowlist" onclick={(ev) => { ev.preventDefault(); open = false; void navigate('/settings/extensions#allowlist'); }}>Open the rule</a>
          </p>
        {:else if site.allowlisted}
          <Button size="sm" variant="primary" onclick={resume}>Resume</Button>
        {:else if site.pauseKey}
          <Button size="sm" onclick={pause}>Pause blocking on <span class="mono key">{site.pauseKey}</span></Button>
        {/if}
      </div>

      {#if !site.allowlisted}
        <ul class="switches" aria-label="On this site">
          {#each SITE_SWITCHES as k (k)}
            <li>
              <div class="sw-text">
                <span>{SWITCH_LABELS[k].label}</span>
                <span class="hint">{SWITCH_LABELS[k].hint}</span>
              </div>
              <Switch size="sm" aria-label="{SWITCH_LABELS[k].label} on {site.switchKey}" checked={site.switches[k]} onchange={(v) => toggle(k, v)} />
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if changed}
      <Button size="sm" variant="primary" icon={RotateCw} onclick={reload}>Reload to apply</Button>
    {/if}

    <a class="more" href="/extensions" onclick={(ev) => { ev.preventDefault(); open = false; void navigate('/extensions'); }}>
      <Puzzle size={14} aria-hidden="true" /> Extensions
    </a>
  </div>
</Popover>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    font-family: var(--font-display);
    font-size: var(--text-md);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .site {
    font-size: var(--text-xs);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-2);
  }

  .note.warn {
    color: var(--warning);
  }

  .note.error {
    color: var(--danger);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .counts {
    border-top: 1px solid var(--hairline);
  }

  .counts li,
  .direct {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 30px;
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .counts li {
    border-bottom: 1px solid var(--hairline);
  }

  .n {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--text);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .actions :global(.btn) {
    max-width: 100%;
  }

  .key {
    margin-left: 0.3em;
    font-size: var(--text-xs);
  }

  .switches {
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  .switches li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
  }

  .switches li + li {
    border-top: 1px solid var(--hairline);
  }

  .sw-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    font-size: var(--text-sm);
    color: var(--text);
  }

  .more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    color: var(--accent);
    align-self: flex-start;
  }
</style>
