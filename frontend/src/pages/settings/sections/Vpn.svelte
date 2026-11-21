<script lang="ts">
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Icon from '../../../components/Icon.svelte';
  import SegmentedControl from '../../../components/SegmentedControl.svelte';
  import Select from '../../../components/Select.svelte';
  import Skeleton from '../../../components/Skeleton.svelte';
  import Switch from '../../../components/Switch.svelte';
  import { server } from '../../../app/server.svelte';
  import { api, isApiError } from '../../../lib/api';
  import { formatRelativeTime } from '../../../lib/format';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';

  type Vpn = Settings['vpn'];
  const S = 'vpn' as const;
  const v = $derived(settings.value.vpn);
  const customWisp = $derived(settings.value.browser.wispServers.length > 0);
  const set = <K extends keyof Vpn>(k: K, val: Vpn[K]): void => void settings.set(S, k, val);

  interface Location {
    id: string;
    label: string;
    country_code: string;
    country: string;
    city: string;
    provider_note: string | null;
    status: 'up' | 'down' | 'unknown';
    checked_at: number | null;
  }

  let locations = $state<Location[] | null>(null);
  let problem = $state<string | null>(null);
  const offered = $derived(server.config ? server.config.features.vpn_gateway : null);

  $effect(() => {
    if (offered === false) return;
    const ctrl = new AbortController();
    api
      .get<{ profiles: Location[] }>('/api/vpn/locations', { signal: ctrl.signal, timeoutMs: 8000 })
      .then((r) => {
        locations = Array.isArray(r?.profiles) ? r.profiles.filter((p) => typeof p.id === 'string') : [];
        problem = null;
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        problem = isApiError(err, 'not_found') ? 'none' : 'The location list could not be loaded from the server.';
        locations = [];
      });
    return () => ctrl.abort();
  });

  const STATUS: Record<Location['status'], string> = { up: 'Online', down: 'Offline', unknown: 'Not checked yet' };
  const options = $derived(
    (locations ?? []).map((l) => ({
      value: l.id,
      label: l.label || [l.city, l.country].filter(Boolean).join(', ') || l.id,
      description: `${STATUS[l.status] ?? 'Unknown'}${l.checked_at ? ` · checked ${formatRelativeTime(l.checked_at)}` : ''}`,
      disabled: false,
    })),
  );
  const unavailable = $derived(offered === false || (locations !== null && locations.length === 0));
  const selectedMissing = $derived(!!v.preferredLocation && locations !== null && !locations.some((l) => l.id === v.preferredLocation));
</script>

<Group title="Gateway">
  {#snippet note()}
    <p class="scope">
      <Icon icon={ShieldAlert} size={16} />
      <span>
        <strong>Only traffic inside GNOME is routed.</strong> Pages opened in GNOME’s browser go through the gateway;
        your other tabs, apps and the rest of your device are not affected. Games from publisher sites load directly and
        are not routed.
      </span>
    </p>
  {/snippet}
  <Row
    section={S}
    id="mode"
    disabled={unavailable && v.mode === 'off'}
    description={offered === false || problem === 'none'
      ? 'This server has no VPN gateway configured.'
      : customWisp
        ? 'Custom Wisp servers are set under Advanced: they bypass the gateway, so the VPN has no effect until you remove them.'
        : undefined}
  >
    {#snippet control()}
      <SegmentedControl
        label="VPN gateway"
        value={v.mode}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'gateway', label: 'Gateway', disabled: unavailable },
        ]}
        onchange={(val) => set('mode', val)}
      />
    {/snippet}
  </Row>
  <Row
    section={S}
    id="preferredLocation"
    disabled={unavailable}
    error={selectedMissing ? 'The saved location is no longer offered by this server.' : problem && problem !== 'none' ? problem : null}
  >
    {#snippet control()}
      {#if locations === null && offered !== false}
        <Skeleton width="200px" height="32px" />
      {:else}
        <Select
          value={v.preferredLocation ?? ''}
          options={[{ value: '', label: 'Automatic', description: 'The first location that is online' }, ...options]}
          onchange={(val) => set('preferredLocation', val || null)}
        />
      {/if}
    {/snippet}
  </Row>
</Group>

<Group title="Behaviour">
  <Row section={S} id="autoConnect" disabled={unavailable}>
    {#snippet control()}
      <Switch checked={v.autoConnect} onchange={(val) => set('autoConnect', val)} />
    {/snippet}
  </Row>
  <Row section={S} id="killSwitch">
    {#snippet control()}
      <Switch checked={v.killSwitch} onchange={(val) => set('killSwitch', val)} />
    {/snippet}
  </Row>
  <Row section={S} id="verifyExit">
    {#snippet control()}
      <Switch checked={v.verifyExit} onchange={(val) => set('verifyExit', val)} />
    {/snippet}
  </Row>
</Group>

<style>
  .scope {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius);
    background: color-mix(in oklab, var(--slate) 7%, transparent);
  }

  .scope :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--slate);
  }
</style>
