<!--
  One registered settings row (registry.ts): label and description come from the registry, reset-to-default resets
  the row's paths, and the row hides itself while a search is active and it does not match, and in builds where the
  feature that acts on its setting is not present (registry `needs`, settings/features.ts).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import SettingRow from '../../components/SettingRow.svelte';
  import { getSettingsSearch } from './ctx';
  import { pathsAreDefault, resetPaths } from './edit';
  import { ROW_BY_KEY, rowActive, type SectionId } from './registry';

  interface Props {
    section: SectionId;
    id: string;
    /** Replaces the registry description (e.g. to add live details). */
    description?: string;
    disabled?: boolean;
    error?: string | null;
    stacked?: boolean;
    /** Hide the reset button even when the row has paths (e.g. reset lives elsewhere). */
    noReset?: boolean;
    control: Snippet;
    children?: Snippet;
  }

  let { section, id, description, disabled = false, error = null, stacked = false, noReset = false, control, children }: Props = $props();

  const key = $derived(`${section}.${id}`);
  const meta = $derived(ROW_BY_KEY.get(key));
  const search = getSettingsSearch();
  const visible = $derived(!!meta && rowActive(meta) && (!search.active || search.matches.has(key)));
  const isDefault = $derived(meta ? pathsAreDefault(meta.paths) : true);
</script>

{#if meta && visible}
  <div class="row" {id} data-row={key}>
    <SettingRow
      label={meta.label}
      description={description ?? meta.description}
      {isDefault}
      onreset={meta.paths.length && !noReset ? () => resetPaths(meta.paths) : undefined}
      {disabled}
      {error}
      {stacked}
      {control}
      {children}
    />
  </div>
{/if}

<style>
  .row {
    scroll-margin-top: var(--space-16);
    border-radius: var(--radius);
    transition: background-color calc(var(--dur-4) * var(--motion)) var(--ease-out);
  }

  /* Phones: SettingRow stacks every control under its text; keep switches beside the label like native settings. */
  @media (max-width: 640px) {
    .row :global(.setting-row:not(.stacked):has(> .control > .switch-wrap)) {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .row :global(.setting-row:not(.stacked):has(> .control > .switch-wrap) > .control) {
      justify-content: flex-end;
    }
  }

  .row:global(.flash) {
    background: var(--accent-soft);
    box-shadow: 0 0 0 var(--space-3) var(--accent-soft);
  }
</style>
