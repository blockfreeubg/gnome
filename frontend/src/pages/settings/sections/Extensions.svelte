<script lang="ts">
  import Switch from '../../../components/Switch.svelte';
  import FilterLists from '../../../extensions/app/ui/FilterLists.svelte';
  import SiteRules from '../../../extensions/app/ui/SiteRules.svelte';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';

  type Ext = Settings['extensions'];
  type Blocker = keyof Ext['enabled'];
  const S = 'extensions' as const;
  const e = $derived(settings.value.extensions);
  const set = <K extends keyof Ext>(k: K, v: Ext[K]): void => void settings.set(S, k, v);
  const setEnabled = (k: Blocker, v: boolean): void => set('enabled', { ...e.enabled, [k]: v });

  const BLOCKERS: ReadonlyArray<{ key: Blocker; row: string }> = [
    { key: 'adblock', row: 'adblock' },
    { key: 'trackers', row: 'trackers' },
    { key: 'privacy', row: 'privacy' },
    { key: 'cookies', row: 'cookieManager' },
    { key: 'cosmetic', row: 'cosmetic' },
  ];
</script>

<Group title="Built-in extensions">
  {#snippet note()}
    GNOME’s blockers run inside its own browser on sites you open there.
    <a href="/extensions">Extensions</a> shows what they blocked and how they work.
  {/snippet}
  {#each BLOCKERS as b (b.key)}
    <Row section={S} id={b.row}>
      {#snippet control()}
        <Switch checked={e.enabled[b.key]} onchange={(v) => setEnabled(b.key, v)} />
      {/snippet}
    </Row>
  {/each}
  <Row section={S} id="cosmeticAggressive" disabled={!e.enabled.cosmetic}>
    {#snippet control()}
      <Switch checked={e.cosmeticAggressive} onchange={(v) => set('cosmeticAggressive', v)} />
    {/snippet}
  </Row>
</Group>

<Group title="Filter lists">
  <Row section={S} id="autoUpdateLists">
    {#snippet control()}
      <Switch checked={e.autoUpdateLists} onchange={(v) => set('autoUpdateLists', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="lists" stacked>
    {#snippet control()}
      <FilterLists />
    {/snippet}
  </Row>
</Group>

<Group title="Site rules">
  <SiteRules />
</Group>
