<!--
  VPN (/vpn; docs/WAVE-C.md §7.1, DESIGN §12 "VPN"): the connection as the app knows it (D13), Connect / Disconnect
  (D12: this browser only), the exit check the server ran (what the check service reported, never proof, D14), the
  locations, the kill switch and what the VPN does and does not do. Lane v3 (§8.1): "This browser's check" (only with
  `vpn.verifyExit` and a check service; never proof), the "Connect automatically" and "Check this browser's exit"
  switches, and the persistent "tabs on the previous route" line (it replaces v1's 10-second note while n > 0).
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from '../../components/Button.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import SettingRow from '../../components/SettingRow.svelte';
  import Switch from '../../components/Switch.svelte';
  import type { PageProps } from '../../app/routes';
  import { server } from '../../app/server.svelte';
  import { formatRelativeTime } from '../../lib/format';
  import { settings } from '../../settings/store.svelte';
  import * as copy from '../../vpn/copy';
  import { vpnState } from '../../vpn/state.svelte';
  import type { VpnLocation } from '../../vpn/types';
  import * as bcopy from './browser-check.svelte';
  import { browserCheck } from './browser-check.svelte';

  type BrowserModule = typeof import('../../browser/browser.svelte');
  // The browser module (lazy: the page does not pull it into its chunk); its facts for this browser's check.
  let browserRef = $state.raw<BrowserModule['browser'] | null>(null);

  let {}: PageProps = $props();

  const vpn = vpnState();
  const s = $derived(settings.value.vpn);
  const offered = $derived(server.config?.wisp.profiles ?? null);
  const connection = $derived(vpn.connection);
  const locations = $derived(vpn.locations);
  const noLocations = $derived(offered !== null && offered.length === 0);
  const on = $derived(s.mode === 'gateway');

  const tone = $derived(
    connection.kind === 'connected'
      ? connection.exitWarning
        ? 'warning'
        : 'ok'
      : connection.kind === 'connecting'
        ? 'starting'
        : connection.kind === 'blocked'
          ? 'danger'
          : connection.kind === 'fallback'
            ? 'warning'
            : 'off',
  );
  const current = $derived.by<VpnLocation | null>(() => {
    const list = locations ?? [];
    const loc = 'location' in connection ? connection.location : null;
    const id = loc?.id ?? s.preferredLocation ?? list.find((l) => l.status === 'up')?.id ?? list[0]?.id ?? null;
    return list.find((l) => l.id === id) ?? null;
  });
  const exitWarning = $derived(connection.kind === 'connected' || connection.kind === 'connecting' ? connection.exitWarning : null);
  const warnLabel = $derived(connection.kind === 'connected' || connection.kind === 'connecting' ? connection.location.label : '');
  const service = $derived(vpn.checkService);
  const exit = $derived(current?.exit ?? null);
  const webrtcWarning = $derived(settings.value.privacy.webrtc === 'allow' && !s.killSwitch);
  // This browser's check, for the location the page shows (only with the switch on and a check service).
  const own = $derived(s.verifyExit && service && current && browserCheck.result?.locationId === current.id ? browserCheck.result : null);
  const ownDiffers = $derived(!!own?.answer && exit?.state === 'ok' && !!exit.ip && own.answer.ip !== exit.ip);
  const previousTabs = $derived(browserRef?.previousRouteTabs ?? 0);

  let now = $state(Date.now());
  const canCheck = $derived.by(() => {
    void now;
    void checking;
    return current ? vpn.canCheck(current.id) : false;
  });
  let checking = $state(false);
  async function checkAgain(): Promise<void> {
    if (!current) return;
    checking = true;
    try {
      const b = browserRef;
      const own =
        b && s.verifyExit
          ? browserCheck.run({ vpnLocation: b.vpnLocation, engineState: b.engineState, verifyExit: s.verifyExit, verifyUrl: vpn.verifyUrl, verify: (u) => b.verifyExit(u) })
          : Promise.resolve();
      await Promise.all([vpn.checkNow(current.id), own]);
    } finally {
      checking = false;
      now = Date.now();
    }
  }

  // Locations listbox (Automatic first): arrow keys move, Enter / Space / click choose.
  const options = $derived([{ id: null as string | null, label: copy.AUTOMATIC }, ...(locations ?? []).map((l) => ({ id: l.id as string | null, label: l.label }))]);
  let active = $state(0);
  const selectedIndex = $derived(Math.max(0, options.findIndex((o) => o.id === (s.preferredLocation ?? null))));
  function onListKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      active = Math.min(options.length - 1, Math.max(0, active + (ev.key === 'ArrowDown' ? 1 : -1)));
    } else if (ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      active = ev.key === 'Home' ? 0 : options.length - 1;
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      vpn.select(options[active]?.id ?? null);
    }
  }

  let stopWatch: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    stopWatch = vpn.watch();
    void import('../../browser/browser.svelte').then((m) => (browserRef = m.browser));
    active = selectedIndex;
    tick = setInterval(() => (now = Date.now()), 15_000);
  });
  onDestroy(() => {
    stopWatch?.();
    clearInterval(tick);
  });
</script>

<div class="page narrow vpn">
  <PageHeader title="VPN" description="Routes pages you open in GNOME through a location this server's operator runs. Nothing else on your device." />

  <section class="card hero" aria-labelledby="vpn-state-h">
    <h2 id="vpn-state-h" class="sr-only">Connection</h2>
    <div class="state-row">
      <span class="dot {tone}" aria-hidden="true"></span>
      <p class="state" role="status" aria-label="Connection">{copy.stateText(connection)}</p>
    </div>
    {#if exitWarning}
      <p class="warn"><TriangleAlert size={14} aria-hidden="true" /> {copy.exitWarningText(warnLabel, exitWarning)}</p>
    {/if}
    <p class="line">{copy.stateLine(connection)}</p>
    {#if current && !noLocations}
      <p class="where">
        <span class="where-label">{current.label}</span>
        {#if current.city || current.country}<span> · {[current.city, current.country].filter(Boolean).join(', ')}</span>{/if}
      </p>
      {#if current.provider_note}<p class="note">{current.provider_note}</p>{/if}
    {/if}
    {#if noLocations}<p class="line">{copy.NO_LOCATIONS}</p>{/if}
    {#if on && previousTabs > 0}<p class="route-notice">{bcopy.previousRouteText(previousTabs)}</p>
    {:else if vpn.routeNotice}<p class="route-notice">{vpn.routeNotice}</p>{/if}
    <div class="actions">
      {#if on}
        <Button variant="outline" size="lg" onclick={() => vpn.disconnect()}>Disconnect</Button>
        {#if connection.kind === 'blocked'}<a class="kill-link" href="#kill-switch">Kill switch settings</a>{/if}
      {:else if !noLocations}
        <Button variant="primary" size="lg" onclick={() => vpn.connect()}>Connect</Button>
      {/if}
    </div>
  </section>

  <section class="card" aria-labelledby="vpn-exit-h">
    <h2 id="vpn-exit-h" class="eyebrow-title">Exit check</h2>
    {#if !vpn.verifyUrl || !service}
      <p class="text">{copy.NO_CHECKS}</p>
    {:else if vpn.checkDenied}
      <p class="text">{copy.CHECK_DENIED}</p>
    {:else if !current || !exit}
      <p class="text">{copy.NOT_CHECKED}</p>
    {:else}
      {#if exit.state === 'ok'}
        <p class="text">{copy.exitReport(service, exit)}{exit.checked_at ? ` · checked ${formatRelativeTime(exit.checked_at, now)}` : ''}</p>
        {#if exit.provider_exit !== null}<p class="text">{copy.providerExitText(service, exit.provider_exit)}</p>{/if}
        {#if exit.country_match === false && exit.country}<p class="warn">{copy.countryMismatchText(service, exit.country, current.country)}</p>{/if}
      {:else if exit.state === 'failed'}
        <p class="warn">{exit.error ? copy.EXIT_REASONS[exit.error] : copy.EXIT_REASONS.bad_answer}</p>
      {:else}
        <p class="text">{copy.NOT_CHECKED}</p>
      {/if}
      {#if exit.v6}<p class="text">{copy.v6Text(service, exit.v6)}</p>{/if}
    {/if}
    {#if own && service}
      <div class="own" role="group" aria-label={bcopy.BROWSER_CHECK_TITLE}>
        {#if own.answer}
          <p class="text">{bcopy.browserCheckText(service, own.answer)}</p>
          <p class="note">{bcopy.BROWSER_CHECK_CAVEAT}</p>
          {#if ownDiffers && current}<p class="warn"><TriangleAlert size={14} aria-hidden="true" /> {bcopy.mismatchText(current.label)}</p>{/if}
        {:else}
          <p class="text">{bcopy.BROWSER_CHECK_FAILED}</p>
        {/if}
      </div>
    {/if}
    {#if vpn.verifyUrl && service && current}
      <div class="actions">
        <Button variant="outline" icon={RotateCcw} loading={checking} disabled={checking || !canCheck} onclick={checkAgain}>{copy.CHECK_AGAIN}</Button>
      </div>
    {/if}
  </section>

  {#if locations && locations.length}
    <section class="card" aria-labelledby="vpn-loc-h">
      <h2 id="vpn-loc-h" class="eyebrow-title">Locations</h2>
      <div
        class="listbox"
        role="listbox"
        aria-label="Locations"
        tabindex="0"
        aria-activedescendant="vpn-opt-{active}"
        onkeydown={onListKey}
      >
        {#each options as opt, i (opt.id ?? '')}
          {@const loc = opt.id ? locations.find((l) => l.id === opt.id) : null}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="vpn-opt-{i}"
            class="option"
            class:selected={i === selectedIndex}
            class:active={i === active}
            role="option"
            aria-selected={i === selectedIndex}
            aria-label={opt.label}
            aria-describedby={loc ? `vpn-opt-${i}-d` : undefined}
            tabindex="-1"
            onclick={() => {
              active = i;
              vpn.select(opt.id);
            }}
          >
            <span class="opt-label">{opt.label}</span>
            {#if loc}
              <span class="opt-detail" id="vpn-opt-{i}-d">
                <span class="dot small {loc.status === 'up' ? 'ok' : loc.status === 'down' ? 'danger' : 'off'}" aria-hidden="true"></span>
                {copy.STATUS_WORDS[loc.status]}{#if loc.exit.state === 'ok' && loc.exit.ip && service}{` · ${copy.exitReport(service, loc.exit)}`}{:else if loc.exit.state === 'failed' && loc.exit.error}{` · ${copy.EXIT_REASONS[loc.exit.error]}`}{/if}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {:else if vpn.loadError && !noLocations}
    <section class="card">
      <p class="warn"><ShieldOff size={14} aria-hidden="true" /> {copy.LOCATIONS_ERROR} {vpn.loadError}</p>
      <div class="actions"><Button variant="outline" icon={RotateCcw} onclick={() => void vpn.refresh()}>Try again</Button></div>
    </section>
  {/if}

  <section class="card rows" aria-labelledby="vpn-beh-h" id="kill-switch">
    <h2 id="vpn-beh-h" class="eyebrow-title">Behaviour</h2>
    <SettingRow label={bcopy.AUTO_CONNECT_LABEL} description={bcopy.AUTO_CONNECT_HELP}>
      {#snippet control()}
        <Switch aria-label={bcopy.AUTO_CONNECT_LABEL} checked={s.autoConnect} onchange={(v) => void settings.set('vpn', 'autoConnect', v)} />
      {/snippet}
    </SettingRow>
    <SettingRow label={copy.KILL_SWITCH_LABEL} description={copy.KILL_SWITCH_HELP}>
      {#snippet control()}
        <Switch aria-label={copy.KILL_SWITCH_LABEL} checked={s.killSwitch} onchange={(v) => void settings.set('vpn', 'killSwitch', v)} />
      {/snippet}
    </SettingRow>
    {#if vpn.verifyUrl && service}
      <SettingRow label={bcopy.VERIFY_LABEL} description={bcopy.VERIFY_HELP}>
        {#snippet control()}
          <Switch aria-label={bcopy.VERIFY_LABEL} checked={s.verifyExit} onchange={(v) => void settings.set('vpn', 'verifyExit', v)} />
        {/snippet}
      </SettingRow>
    {/if}
  </section>

  <section class="card privacy" aria-labelledby="vpn-priv-h">
    <h2 id="vpn-priv-h" class="eyebrow-title">{copy.PRIVACY_TITLE}</h2>
    {#if webrtcWarning}<p class="warn"><TriangleAlert size={14} aria-hidden="true" /> {copy.WEBRTC_WARNING}</p>{/if}
    {#each copy.privacyParagraphs(service) as p (p.lead)}
      <p class="text"><strong>{p.lead}</strong> {p.text}</p>
    {/each}
    <p class="footer">{copy.FOOTER}</p>
  </section>
</div>

<style>
  .card {
    margin-top: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }
  .hero {
    padding: var(--space-6);
  }
  .state-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .state {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 24px;
    letter-spacing: -0.03em;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
    background: var(--text-4);
  }
  .dot.small {
    width: 7px;
    height: 7px;
    display: inline-block;
    margin-right: 4px;
    vertical-align: middle;
  }
  .dot.ok {
    background: var(--success);
  }
  .dot.starting,
  .dot.warning {
    background: var(--warning);
  }
  .dot.danger {
    background: var(--danger);
  }
  .line,
  .text {
    margin: 10px 0 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text-2);
  }
  .text strong {
    color: var(--text);
    font-weight: 600;
  }
  .warn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--warning);
  }
  .where {
    margin: 14px 0 0;
    font-size: 13px;
    color: var(--text-2);
  }
  .where-label {
    color: var(--text);
    font-weight: 600;
  }
  .note,
  .footer {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-3);
  }
  .footer {
    margin-top: var(--space-4);
  }
  .route-notice {
    margin: 12px 0 0;
    font-size: 12.5px;
    color: var(--text-2);
    padding: 8px 12px;
    border-radius: var(--radius);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: var(--space-5);
    flex-wrap: wrap;
  }
  .kill-link {
    font-size: 13px;
    color: var(--text-2);
  }
  .eyebrow-title {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--tracking-eyebrow, 0.08em);
    color: var(--text-3);
  }
  .listbox {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
    outline: none;
  }
  .listbox:focus-visible .option.active {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .option:hover {
    background: var(--hover);
  }
  .option.selected {
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
  }
  .opt-label {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text);
  }
  .opt-detail {
    font-size: 12px;
    color: var(--text-3);
  }
  .rows {
    padding-bottom: var(--space-2);
  }
  @media (max-width: 759px) {
    .card,
    .hero {
      padding: var(--space-5);
    }
    .actions > :global(.btn) {
      flex: 1 1 auto;
    }
  }
</style>
