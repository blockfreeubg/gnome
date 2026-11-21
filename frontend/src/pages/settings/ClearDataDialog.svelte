<!--
  "Clear browsing data": time range + categories. Uses the clearers registry (settings/clearers.ts); categories whose
  owner has not registered a clearer yet fall back to the built-in IndexedDB clearers, or are shown as unavailable.
-->
<script lang="ts">
  import Button from '../../components/Button.svelte';
  import Checkbox from '../../components/Checkbox.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Select from '../../components/Select.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { listClearers, type ClearerDef } from '../../settings/clearers';
  import { BUILTIN_CLEARERS, EXPECTED_CLEARERS } from '../../settings/clearers-builtin';
  import { isFeatureActive } from '../../settings/features';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open = $bindable(), onclose }: Props = $props();

  type Range = 'hour' | 'day' | 'week' | 'month' | 'all';
  const RANGES: ReadonlyArray<{ value: Range; label: string; ms: number | null }> = [
    { value: 'hour', label: 'Last hour', ms: 3600_000 },
    { value: 'day', label: 'Last 24 hours', ms: 86_400_000 },
    { value: 'week', label: 'Last 7 days', ms: 7 * 86_400_000 },
    { value: 'month', label: 'Last 4 weeks', ms: 28 * 86_400_000 },
    { value: 'all', label: 'All time', ms: null },
  ];

  let range = $state<Range>('hour');
  let selected = $state<Record<string, boolean>>({ history: true, siteData: false, cache: true, downloads: false, closedTabs: false });
  let busy = $state(false);

  interface Entry {
    id: string;
    label: string;
    description?: string;
    def: ClearerDef | null;
  }

  /**
   * Registered clearers win; then built-ins. Expected categories without a clearer (cookies and site data, closed
   * tabs: the built-in browser registers them when it starts) are listed as unavailable, and only in builds that
   * include the browser: without it that data does not exist.
   */
  const entries = $derived.by((): Entry[] => {
    const registered = listClearers();
    const byId = new Map<string, ClearerDef>(BUILTIN_CLEARERS.map((c) => [c.id, c]));
    for (const c of registered) byId.set(c.id, c);
    const browser = isFeatureActive('browser');
    const out: Entry[] = [];
    for (const e of EXPECTED_CLEARERS) {
      const def = byId.get(e.id) ?? null;
      if (def || browser) out.push({ id: e.id, label: def?.label ?? e.label, description: def?.description ?? e.description, def });
      byId.delete(e.id);
    }
    const rest = [...byId.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
    for (const def of rest) out.push({ id: def.id, label: def.label, description: def.description, def });
    return out;
  });

  const rangeMs = $derived(RANGES.find((r) => r.value === range)?.ms ?? null);
  const usable = (e: Entry): boolean => !!e.def && (rangeMs === null || !!e.def.supportsTimeRange);
  const chosen = $derived(entries.filter((e) => usable(e) && selected[e.id]));

  function note(e: Entry): string | undefined {
    if (!e.def) return `${e.description ?? ''} Available after the browser has started in this tab.`.trim();
    if (rangeMs !== null && !e.def.supportsTimeRange) return `${e.description ?? ''} Only with “All time”.`.trim();
    return e.description;
  }

  async function run(): Promise<void> {
    if (!chosen.length) return;
    busy = true;
    const since = rangeMs === null ? undefined : Date.now() - rangeMs;
    const failed: string[] = [];
    for (const e of chosen) {
      try {
        await e.def!.clear(e.def!.supportsTimeRange && since !== undefined ? { since } : {});
      } catch (err) {
        failed.push(`${e.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    busy = false;
    if (failed.length) {
      toast.error('Some data could not be cleared', { description: failed.join(' · ') });
    } else {
      toast.success('Browsing data cleared', { description: chosen.map((e) => e.label).join(', ') });
      open = false;
      onclose();
    }
  }
</script>

<Dialog bind:open title="Clear browsing data" description="Removes data stored in this browser. Synced copies on your account are not affected." size="md" {onclose}>
  <div class="body">
    <Field label="Time range">
      <Select value={range} options={RANGES} onchange={(v) => (range = v)} full />
    </Field>
    <fieldset>
      <legend class="eyebrow">Data</legend>
      {#each entries as e (e.id)}
        <Checkbox
          label={e.label}
          description={note(e)}
          checked={usable(e) && !!selected[e.id]}
          disabled={!usable(e)}
          onchange={(v) => (selected = { ...selected, [e.id]: v })}
        />
      {/each}
    </fieldset>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => ((open = false), onclose())}>Cancel</Button>
    <Button variant="danger" loading={busy} disabled={!chosen.length} onclick={run}>Clear data</Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  legend {
    margin-bottom: var(--space-2);
  }
</style>
