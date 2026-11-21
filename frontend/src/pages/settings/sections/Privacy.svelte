<script lang="ts">
  import Eraser from '@lucide/svelte/icons/eraser';
  import Button from '../../../components/Button.svelte';
  import Dialog from '../../../components/Dialog.svelte';
  import Field from '../../../components/Field.svelte';
  import Select from '../../../components/Select.svelte';
  import Switch from '../../../components/Switch.svelte';
  import SegmentedControl from '../../../components/SegmentedControl.svelte';
  import Tag from '../../../components/Tag.svelte';
  import { engineFacts } from '../../../browser/engine/facts.svelte';
  import { ENGINE_PERMISSION_ASK } from '../../../shared/site-rules';
  import type { EnginePermission } from '../../../shared/engine-protocol';
  import { isFeatureActive } from '../../../settings/features';
  import { SITE_PERMISSIONS, type PermissionValue, type Settings, type SitePermission } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import ClearDataDialog from '../ClearDataDialog.svelte';
  import Group from '../Group.svelte';
  import HostTable from '../HostTable.svelte';
  import Row from '../Row.svelte';

  type Privacy = Settings['privacy'];
  const S = 'privacy' as const;
  const p = $derived(settings.value.privacy);
  const cookies = $derived(settings.value.browser.cookies);
  const set = <K extends keyof Privacy>(k: K, v: Privacy[K]): void => void settings.set(S, k, v);

  let clearOpen = $state(false);

  const PERMISSION_LABELS: Record<SitePermission, string> = {
    camera: 'Camera',
    microphone: 'Microphone',
    geolocation: 'Location',
    notifications: 'Notifications',
    popups: 'Pop-ups',
    autoplay: 'Autoplay with sound',
    clipboard: 'Clipboard',
    fullscreen: 'Fullscreen',
  };
  const VALUE_OPTIONS: ReadonlyArray<{ value: PermissionValue; label: string }> = [
    { value: 'ask', label: 'Ask' },
    { value: 'allow', label: 'Allow' },
    { value: 'block', label: 'Block' },
  ];
  const VALUE_WORDS: Record<PermissionValue, string> = { ask: 'asks', allow: 'allowed', block: 'blocked' };

  /**
   * ENGINE-PROTOCOL §6.14: camera, microphone, location and notifications are never delegated to the browser engine;
   * pop-ups are decided by GNOME (ask/allow/block); autoplay, fullscreen and clipboard writes are enforced per site by
   * the engine host only where this browser lets it (InitResult.enforcedPermissions), with allow/block, and the rows
   * stay hidden until the engine host has said which.
   */
  const UNAVAILABLE: ReadonlySet<SitePermission> = new Set<SitePermission>(['camera', 'microphone', 'geolocation', 'notifications']);
  const ENGINE_PERMS: ReadonlySet<SitePermission> = new Set<SitePermission>(['autoplay', 'fullscreen', 'clipboard']);
  type PermKind = 'unavailable' | 'popups' | 'enforced' | 'not-enforced' | 'unknown';
  function kindOf(perm: SitePermission): PermKind {
    if (UNAVAILABLE.has(perm)) return 'unavailable';
    if (!ENGINE_PERMS.has(perm)) return 'popups';
    if (!engineFacts.known) return 'unknown';
    return engineFacts.enforcedPermissions.includes(perm as EnginePermission) ? 'enforced' : 'not-enforced';
  }
  const editable = $derived(SITE_PERMISSIONS.filter((k) => kindOf(k) === 'popups' || kindOf(k) === 'enforced'));
  const notEnforced = $derived(SITE_PERMISSIONS.filter((k) => kindOf(k) === 'not-enforced'));
  const ALLOW_BLOCK: ReadonlyArray<{ value: PermissionValue; label: string }> = [
    { value: 'allow', label: 'Allow' },
    { value: 'block', label: 'Block' },
  ];
  const optionsFor = (perm: SitePermission): ReadonlyArray<{ value: PermissionValue; label: string }> => (perm === 'popups' ? VALUE_OPTIONS : ALLOW_BLOCK);
  /** A stored `ask` of an engine-enforced permission means what ENGINE_PERMISSION_ASK says (no prompt in v1). */
  const shown = (perm: SitePermission, v: PermissionValue): PermissionValue => (perm !== 'popups' && v === 'ask' ? ENGINE_PERMISSION_ASK[perm as EnginePermission] : v);

  function summary(host: string): string {
    const perms = p.sitePermissions[host] ?? {};
    const parts = editable.filter((k) => perms[k]).map((k) => `${PERMISSION_LABELS[k]} ${VALUE_WORDS[shown(k, perms[k]!)]}`);
    return parts.length ? parts.join(' · ') : 'Uses the defaults';
  }

  // Per-site permission editor.
  let editing = $state<string | null>(null);
  let draft = $state<Partial<Record<SitePermission, PermissionValue | 'default'>>>({});

  function edit(host: string): void {
    editing = host;
    draft = { ...(p.sitePermissions[host] ?? {}) };
  }

  function saveSite(): void {
    if (!editing) return;
    const perms: Partial<Record<SitePermission, PermissionValue>> = {};
    for (const k of SITE_PERMISSIONS) {
      const v = draft[k];
      if (v && v !== 'default') perms[k] = v;
    }
    set('sitePermissions', { ...p.sitePermissions, [editing]: perms });
    editing = null;
  }

  function removeSite(host: string): void {
    const next = { ...p.sitePermissions };
    delete next[host];
    set('sitePermissions', next);
  }
</script>

<Group>
  <Row
    section={S}
    id="clearData"
    description={isFeatureActive('browser') ? undefined : 'Remove the history, downloads list, cached files or recently played games kept in this browser.'}
  >
    {#snippet control()}
      <Button icon={Eraser} onclick={() => (clearOpen = true)}>Clear data…</Button>
    {/snippet}
  </Row>
</Group>

<Group title="Tracking">
  <Row section={S} id="stripTrackingParams">
    {#snippet control()}
      <Switch checked={p.stripTrackingParams} onchange={(v) => set('stripTrackingParams', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="sendGpc">
    {#snippet control()}
      <Switch checked={p.sendGpc} onchange={(v) => set('sendGpc', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="doNotTrack">
    {#snippet control()}
      <Switch checked={p.doNotTrack} onchange={(v) => set('doNotTrack', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="referrer">
    {#snippet control()}
      <Select
        value={p.referrer}
        options={[
          { value: 'default', label: 'Site default' },
          { value: 'origin-cross-site', label: 'Only the site name to other sites' },
          { value: 'none', label: 'Never send' },
        ]}
        onchange={(v) => set('referrer', v)}
      />
    {/snippet}
  </Row>
</Group>

<Group title="Connections">
  <Row section={S} id="webrtc" stacked={p.webrtc === 'allow'}>
    {#snippet control()}
      <div class="webrtc">
        <SegmentedControl
          label="WebRTC"
          value={p.webrtc}
          options={[
            { value: 'block', label: 'Block' },
            { value: 'allow', label: 'Allow' },
          ]}
          onchange={(v) => set('webrtc', v)}
        />
        {#if p.webrtc === 'allow'}
          <p class="warn" role="note">
            WebRTC traffic now goes directly from this device to the sites that use it, outside GNOME and its gateway, so
            they can see your IP address.{settings.value.vpn.mode === 'gateway' && settings.value.vpn.killSwitch ? ' While the VPN kill switch is on, GNOME still blocks it.' : ''}
          </p>
        {/if}
      </div>
    {/snippet}
  </Row>
</Group>

<Group title="Cookies and site data">
  <Row section={S} id="cookies">
    {#snippet control()}
      <Select
        value={cookies.mode}
        options={[
          { value: 'all', label: 'Allow all cookies' },
          { value: 'block-third-party', label: 'Block third-party cookies', description: 'Cookies of other sites than the tab’s page are not sent or stored, also for scripts in their frames' },
          { value: 'block-all', label: 'Block all cookies', description: 'Many sites will not work' },
        ]}
        onchange={(v) => void settings.set('browser', 'cookies', { ...cookies, mode: v })}
      />
    {/snippet}
  </Row>
  <Row section={S} id="cookiesClearOnExit">
    {#snippet control()}
      <Switch checked={cookies.clearOnExit} onchange={(v) => void settings.set('browser', 'cookies', { ...cookies, clearOnExit: v })} />
    {/snippet}
  </Row>
  <Row section={S} id="clearHistoryOnExit">
    {#snippet control()}
      <Switch checked={p.clearHistoryOnExit} onchange={(v) => set('clearHistoryOnExit', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="clearSiteDataOnExit">
    {#snippet control()}
      <Switch checked={p.clearSiteDataOnExit} onchange={(v) => set('clearSiteDataOnExit', v)} />
    {/snippet}
  </Row>
</Group>

<Group title="Permissions">
  <Row section={S} id="defaultPermissions" stacked>
    {#snippet control()}
      <div class="perm-block">
      <div class="perm-grid">
        {#each editable as perm (perm)}
          <Field label={PERMISSION_LABELS[perm]}>
            <Select
              value={shown(perm, p.defaultPermissions[perm])}
              options={optionsFor(perm)}
              size="sm"
              full
              onchange={(v) => set('defaultPermissions', { ...p.defaultPermissions, [perm]: v })}
            />
          </Field>
        {/each}
      </div>
      <ul class="perm-notes" role="list">
        <li>
          <Tag>Not available</Tag>
          <span>Camera, microphone, location and notifications: sites opened in GNOME never get them, because the
            grant would cover every site at once.</span>
        </li>
        {#if notEnforced.length}
          <li>
            <Tag>Always allowed</Tag>
            <span>{notEnforced.map((k) => PERMISSION_LABELS[k]).join(', ')}: this browser does not let GNOME block
              {notEnforced.length === 1 ? 'it' : 'them'} per site, so {notEnforced.length === 1 ? 'it works' : 'they work'} as on any site.</span>
          </li>
        {/if}
        {#if !engineFacts.known}
          <li>
            <Tag>Pending</Tag>
            <span>Autoplay, fullscreen and clipboard settings appear once the browser engine has started in this
              browser and reported which of them it can enforce.</span>
          </li>
        {/if}
      </ul>
      </div>
    {/snippet}
  </Row>
  <Row section={S} id="sitePermissions" stacked>
    {#snippet control()}
      <HostTable
        hosts={Object.keys(p.sitePermissions)}
        inputLabel="Add a site"
        emptyText="No exceptions. Every site uses the defaults above."
        max={5000}
        onadd={(host) => {
          set('sitePermissions', { ...p.sitePermissions, [host]: {} });
          edit(host);
        }}
        onremove={removeSite}
      >
        {#snippet cell(host)}
          <span class="summary">{summary(host)}</span>
          <Button size="sm" variant="ghost" onclick={() => edit(host)}>Edit</Button>
        {/snippet}
      </HostTable>
    {/snippet}
  </Row>
</Group>

<ClearDataDialog bind:open={clearOpen} onclose={() => (clearOpen = false)} />

<Dialog
  open={editing !== null}
  title={editing ? `Permissions for ${editing}` : 'Permissions'}
  description="“Default” follows the default permissions."
  size="sm"
  onclose={() => (editing = null)}
>
  <div class="perm-list">
    {#each editable as perm (perm)}
      <Field label={PERMISSION_LABELS[perm]}>
        <Select
          value={draft[perm] ? shown(perm, draft[perm] as PermissionValue) : 'default'}
          options={[{ value: 'default', label: `Default (${VALUE_OPTIONS.find((o) => o.value === shown(perm, p.defaultPermissions[perm]))?.label})` }, ...optionsFor(perm)]}
          size="sm"
          full
          onchange={(v) => (draft = { ...draft, [perm]: v })}
        />
      </Field>
    {/each}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
    <Button variant="primary" onclick={saveSite}>Save</Button>
  {/snippet}
</Dialog>

<style>
  .perm-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr));
    gap: var(--space-3) var(--space-4);
    width: 100%;
  }

  .perm-block {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .perm-notes {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-2);
    line-height: 1.5;
  }

  .perm-notes li {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
  }

  .perm-notes :global(.tag) {
    flex: none;
  }

  .webrtc {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
  }

  .warn {
    font-size: var(--text-sm);
    color: var(--warning);
    line-height: 1.5;
    max-width: 62ch;
  }

  .perm-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
  }

  .summary {
    font-size: var(--text-sm);
    color: var(--text-2);
    text-align: right;
  }

  @media (max-width: 640px) {
    .summary {
      text-align: left;
    }
  }
</style>
