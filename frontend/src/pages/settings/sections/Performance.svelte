<script lang="ts">
  import Select from '../../../components/Select.svelte';
  import Switch from '../../../components/Switch.svelte';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';

  type Perf = Settings['performance'];
  const S = 'performance' as const;
  const p = $derived(settings.value.performance);
  const set = <K extends keyof Perf>(k: K, v: Perf[K]): void => void settings.set(S, k, v);

  const withCurrent = (list: Array<{ value: string; label: string }>, current: number, unit: string) =>
    list.some((o) => o.value === String(current)) ? list : [...list, { value: String(current), label: `${current} ${unit}` }];

  const discardOptions = $derived(
    withCurrent(
      [
        { value: '5', label: '5 minutes' },
        { value: '15', label: '15 minutes' },
        { value: '30', label: '30 minutes' },
        { value: '60', label: '1 hour' },
        { value: '240', label: '4 hours' },
      ],
      p.discardAfterMinutes,
      'minutes',
    ),
  );
  const cacheOptions = $derived(
    withCurrent(
      [
        { value: '64', label: '64 MB' },
        { value: '128', label: '128 MB' },
        { value: '256', label: '256 MB' },
        { value: '512', label: '512 MB' },
        { value: '1024', label: '1 GB' },
        { value: '2048', label: '2 GB' },
      ],
      p.cacheLimitMB,
      'MB',
    ),
  );
</script>

<Group title="Effects">
  <Row section={S} id="gpuEffects">
    {#snippet control()}
      <Switch checked={p.gpuEffects} onchange={(v) => set('gpuEffects', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="prefetchPages">
    {#snippet control()}
      <Switch checked={p.prefetchPages} onchange={(v) => set('prefetchPages', v)} />
    {/snippet}
  </Row>
</Group>

<Group title="Tabs and memory">
  <Row section={S} id="memorySaver">
    {#snippet control()}
      <Switch checked={p.memorySaver} onchange={(v) => set('memorySaver', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="discardAfterMinutes" disabled={!p.memorySaver}>
    {#snippet control()}
      <Select value={String(p.discardAfterMinutes)} options={discardOptions} onchange={(v) => set('discardAfterMinutes', Number(v))} />
    {/snippet}
  </Row>
  <Row section={S} id="backgroundTabs">
    {#snippet control()}
      <Select
        value={p.backgroundTabs}
        options={[
          { value: 'keep-alive', label: 'Keep running' },
          { value: 'discard', label: 'Unload when hidden', description: 'Saves the most memory; pages reload' },
        ]}
        onchange={(v) => set('backgroundTabs', v)}
      />
    {/snippet}
  </Row>
</Group>

<Group title="Storage">
  <Row section={S} id="cacheLimitMB">
    {#snippet control()}
      <Select value={String(p.cacheLimitMB)} options={cacheOptions} onchange={(v) => set('cacheLimitMB', Number(v))} />
    {/snippet}
  </Row>
</Group>
