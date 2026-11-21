<script lang="ts">
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import FileDown from '@lucide/svelte/icons/file-down';
  import FileUp from '@lucide/svelte/icons/file-up';
  import Info from '@lucide/svelte/icons/info';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from '../../../components/Button.svelte';
  import Icon from '../../../components/Icon.svelte';
  import SegmentedControl from '../../../components/SegmentedControl.svelte';
  import Select from '../../../components/Select.svelte';
  import Switch from '../../../components/Switch.svelte';
  import Tag from '../../../components/Tag.svelte';
  import { copyDiagnostics, exportSettingsFile, importSettingsFile } from '../../../app/builtin';
  import { confirm } from '../../../app/overlays/dialogs.svelte';
  import { toast } from '../../../app/overlays/toast.svelte';
  import { server } from '../../../app/server.svelte';
  import { engineChoice } from '../../../shared/engine-protocol';
  import { createDefaultSettings } from '../../../settings/defaults';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import Group from '../Group.svelte';
  import ListEditor from '../ListEditor.svelte';
  import Row from '../Row.svelte';
  import { parseWispServer } from '../urls';

  type Browser = Settings['browser'];
  const b = $derived(settings.value.browser);
  const set = <K extends keyof Browser>(k: K, v: Browser[K]): void => void settings.set('browser', k, v);
  const S = 'advanced' as const;

  const engines = $derived(server.config?.engines ?? null);
  /** What "Automatic" means on this server (engineChoice: the operator's default and the engines it offers). */
  const autoMeans = $derived.by((): string => {
    const choice = engines ? engineChoice('auto', engines.default, engines) : 'auto';
    if (choice === 'auto') return 'Scramjet, falling back to Ultraviolet';
    const only = engines && !(engines.scramjet && engines.ultraviolet);
    return `${choice === 'scramjet' ? 'Scramjet' : 'Ultraviolet'}, ${only ? 'the only engine on this server' : 'this server’s default'}`;
  });
  const engineOptions = $derived([
    { value: 'auto' as const, label: 'Automatic', description: autoMeans },
    { value: 'scramjet' as const, label: 'Scramjet', disabled: engines ? !engines.scramjet : false, description: engines && !engines.scramjet ? 'Turned off on this server' : undefined },
    {
      value: 'ultraviolet' as const,
      label: 'Ultraviolet',
      disabled: engines ? !engines.ultraviolet : false,
      description: engines && !engines.ultraviolet ? 'Turned off on this server' : undefined,
    },
  ]);

  const proxy = $derived(server.config?.proxy ?? null);
  /** GNOME_ALLOW_CUSTOM_WISP (decisions log 2026-11-11): without it the engine-host CSP allows no other host. */
  const customAllowed = $derived(server.config?.wisp.custom_servers === true);
  const vpnOn = $derived(settings.value.vpn.mode === 'gateway');

  async function resetAll(): Promise<void> {
    const syncing = settings.value.account.sync;
    const ok = await confirm({
      title: 'Reset all settings?',
      message: `Every setting goes back to its default, including shortcuts and site rules. History, bookmarks and other data are not touched.${syncing ? ' Sync stays on, so your other browsers get the defaults too.' : ''}`,
      confirmLabel: 'Reset everything',
      danger: true,
    });
    if (!ok) return;
    // The sync switches belong to this browser, as with import: resetting never turns sync off behind your back.
    settings.replace({ ...createDefaultSettings(), account: settings.value.account }, 'local');
    toast.success('Settings reset to defaults');
  }
</script>

<Group title="Proxy">
  <Row section={S} id="engine">
    {#snippet control()}
      <Select value={b.engine} options={engineOptions} onchange={(v) => set('engine', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="autoFallback">
    {#snippet control()}
      <Switch checked={b.autoFallback} onchange={(v) => set('autoFallback', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="transport">
    {#snippet control()}
      <SegmentedControl
        label="Transport"
        value={b.transport}
        options={[
          { value: 'libcurl', label: 'libcurl' },
          { value: 'epoxy', label: 'Epoxy' },
        ]}
        onchange={(v) => set('transport', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="wispServers" stacked>
    {#snippet control()}
      <div class="stack">
        {#if !customAllowed}
          <p class="note">
            <Icon icon={Info} size={16} />
            <span>
              This GNOME server does not allow custom Wisp servers: the browser engine may only connect to the server’s
              own gateway, which keeps its access rules, VPN locations and leak protection in force. The operator can
              allow them with <code class="mono">GNOME_ALLOW_CUSTOM_WISP</code>.
              {#if b.wispServers.length}Your saved servers stay in your settings but are not used.{/if}
            </span>
          </p>
        {:else}
          <p class="warn">
            <Icon icon={TriangleAlert} size={16} />
            <span>
              A custom server bypasses this GNOME server’s gateway: its access rules, rate limits and VPN locations no
              longer apply, part of GNOME’s leak protection does not cover it, and the server you add sees every site
              you open. Only add servers you trust. Custom servers are not used while the VPN is on.
            </span>
          </p>
          {#if vpnOn && b.wispServers.length}
            <p class="note"><Icon icon={Info} size={16} /><span>The VPN is on, so these servers are not used right now.</span></p>
          {/if}
        {/if}
        {#if customAllowed}
        <ListEditor
          items={b.wispServers}
          inputLabel="Add a Wisp server"
          placeholder="wss://wisp.example.com/"
          emptyText="None. GNOME uses this server’s own Wisp gateway."
          addLabel="Add server"
          max={16}
          parse={parseWispServer}
          onchange={(items) => set('wispServers', items)}
        />
        {/if}
      </div>
    {/snippet}
  </Row>
  <Row section={S} id="isolation" stacked>
    {#snippet control()}
      {#if !proxy}
        <p class="subtle text-sm">Unknown until the server answers.</p>
      {:else if proxy.isolated}
        <div class="iso">
          <Tag tone="success">Isolated</Tag>
          <p class="text-sm muted">
            Proxied pages run on {proxy.origin ?? 'a separate origin'}, so they cannot read GNOME’s storage, your account
            session or the app’s data.
          </p>
        </div>
      {:else}
        <div class="iso">
          <Tag tone="warning">Single origin</Tag>
          <p class="text-sm muted">
            Proxied pages run on the same origin as GNOME. A hostile page could read GNOME’s local data and act with
            your session. The server operator can fix this by giving the proxy its own host name or port
            (<code class="mono">GNOME_PROXY_ORIGIN</code> or <code class="mono">GNOME_PROXY_BIND</code>).
          </p>
        </div>
      {/if}
    {/snippet}
  </Row>
</Group>

<Group title="Maintenance">
  <Row section={S} id="diagnostics">
    {#snippet control()}
      <div class="buttons">
        <Button size="sm" icon={ClipboardCopy} onclick={() => void copyDiagnostics()}>Copy diagnostics</Button>
        <Button size="sm" variant="ghost" icon={Info} href="/about">About GNOME</Button>
      </div>
    {/snippet}
  </Row>
  <Row section={S} id="importExport">
    {#snippet control()}
      <div class="buttons">
        <Button size="sm" icon={FileDown} onclick={exportSettingsFile}>Export</Button>
        <Button size="sm" icon={FileUp} onclick={importSettingsFile}>Import</Button>
      </div>
    {/snippet}
  </Row>
  <Row section={S} id="resetAll">
    {#snippet control()}
      <Button size="sm" variant="danger" icon={RotateCcw} onclick={resetAll}>Reset all…</Button>
    {/snippet}
  </Row>
</Group>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
  }

  .warn {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-sm);
    color: var(--text-2);
    line-height: 1.5;
    max-width: 68ch;
  }

  .warn :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warning);
  }

  .note {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-sm);
    color: var(--text-2);
    line-height: 1.5;
    max-width: 68ch;
  }

  .note :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--slate);
  }

  .iso {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .iso p {
    max-width: 60ch;
    line-height: 1.5;
  }

  .buttons {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
</style>
