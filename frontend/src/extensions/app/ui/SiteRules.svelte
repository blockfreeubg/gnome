<!--
  The content blocker's site-rule editors (WAVE-B3 §7.1, §9), shared by Settings → Extensions and the Extensions page:
  allowed sites, per-site overrides and cookie rules, each a registered settings row (pages/settings/registry.ts,
  gated by the `extensions` feature). A bare host typed in is stored as `*.<host>` (also its subdomains) unless "Only
  this host" is ticked; IP literals and `host:port` keys stay as typed (hosts.ts siteRuleKeyFromInput).
-->
<script lang="ts">
  import Field from '../../../components/Field.svelte';
  import Select from '../../../components/Select.svelte';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import HostTable from '../../../pages/settings/HostTable.svelte';
  import { siteRuleKeyFromInput } from '../../../pages/settings/hosts';
  import ListEditor from '../../../pages/settings/ListEditor.svelte';
  import Row from '../../../pages/settings/Row.svelte';

  type Ext = Settings['extensions'];
  const S = 'extensions' as const;
  const e = $derived(settings.value.extensions);
  const set = <K extends keyof Ext>(k: K, v: Ext[K]): void => void settings.set(S, k, v);

  type Override = 'default' | 'on' | 'off';
  const SITE_KEYS: ReadonlyArray<{ key: 'adblock' | 'trackers' | 'cosmetic'; label: string }> = [
    { key: 'adblock', label: 'Ads' },
    { key: 'trackers', label: 'Trackers' },
    { key: 'cosmetic', label: 'Cosmetic' },
  ];

  function overrideOf(host: string, key: 'adblock' | 'trackers' | 'cosmetic'): Override {
    const v = e.perSite[host]?.[key];
    return v === undefined ? 'default' : v ? 'on' : 'off';
  }

  function setOverride(host: string, key: 'adblock' | 'trackers' | 'cosmetic', v: Override): void {
    const cur = { ...(e.perSite[host] ?? {}) };
    if (v === 'default') delete cur[key];
    else cur[key] = v === 'on';
    set('perSite', { ...e.perSite, [host]: cur });
  }

  function removeKey<T>(rec: Record<string, T>, host: string): Record<string, T> {
    const next = { ...rec };
    delete next[host];
    return next;
  }

  function parseHost(raw: string, opts: { onlyThisHost: boolean }): { value: string } | { error: string } {
    const h = siteRuleKeyFromInput(raw, opts.onlyThisHost);
    return h ? { value: h } : { error: 'Enter a host name such as example.com.' };
  }
</script>

<Row section={S} id="allowlist" stacked>
  {#snippet control()}
    <ListEditor
      items={e.allowlist}
      inputLabel="Add an allowed site"
      placeholder="example.com"
      emptyText="No allowed sites. Blocking applies everywhere."
      addLabel="Add site"
      max={5000}
      hostChoice
      parse={parseHost}
      onchange={(items) => set('allowlist', items)}
    />
  {/snippet}
</Row>
<Row section={S} id="perSite" stacked>
  {#snippet control()}
    <HostTable
      hosts={Object.keys(e.perSite)}
      inputLabel="Add a site override"
      emptyText="No overrides."
      max={5000}
      siteRules
      onadd={(host) => set('perSite', { ...e.perSite, [host]: { adblock: false } })}
      onremove={(host) => set('perSite', removeKey(e.perSite, host))}
    >
      {#snippet cell(host)}
        {#each SITE_KEYS as k (k.key)}
          <Field label="{k.label} on {host}" hideLabel>
            <Select
              size="sm"
              value={overrideOf(host, k.key)}
              options={[
                { value: 'default', label: `${k.label}: default` },
                { value: 'on', label: `${k.label}: blocked` },
                { value: 'off', label: `${k.label}: allowed` },
              ]}
              onchange={(v) => setOverride(host, k.key, v)}
            />
          </Field>
        {/each}
      {/snippet}
    </HostTable>
  {/snippet}
</Row>
<Row section={S} id="cookieRules" stacked disabled={!e.enabled.cookies}>
  {#snippet control()}
    <div class="cookie-rules">
      <HostTable
        hosts={Object.keys(e.cookieRules)}
        inputLabel="Add a cookie rule"
        emptyText="No cookie rules. Sites follow the cookie setting under Privacy."
        max={5000}
        siteRules
        onadd={(host) => set('cookieRules', { ...e.cookieRules, [host]: 'session' })}
        onremove={(host) => set('cookieRules', removeKey(e.cookieRules, host))}
      >
        {#snippet cell(host)}
          <Field label="Cookies on {host}" hideLabel>
            <Select
              size="sm"
              value={e.cookieRules[host] ?? 'session'}
              options={[
                { value: 'allow', label: 'Allow' },
                { value: 'session', label: 'Until GNOME closes' },
                { value: 'block', label: 'Block' },
              ]}
              onchange={(v) => set('cookieRules', { ...e.cookieRules, [host]: v })}
            />
          </Field>
        {/snippet}
      </HostTable>
      <p class="note" data-cookie-rules-note>While the cookie manager is on, GNOME’s browser engine receives all cookie rules.</p>
    </div>
  {/snippet}
</Row>

<style>
  .cookie-rules {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }

  .note {
    font-size: var(--text-xs);
    color: var(--text-3);
  }
</style>
