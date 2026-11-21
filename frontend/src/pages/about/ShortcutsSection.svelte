<!-- Keyboard shortcut reference, built from the user's current bindings (settings.browser.shortcuts). -->
<script lang="ts">
  import Kbd from '../../components/Kbd.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';
  import { isApplePlatform } from '../../lib/platform';
  import { engineFacts } from '../../browser/engine/facts.svelte';
  import { shortcutActive } from '../../settings/features';
  import type { ShortcutAction } from '../../settings/schema';
  import { settings } from '../../settings/store.svelte';
  import { shortcutReference } from './shortcut-reference';

  const apple = isApplePlatform();
  const ZOOM: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>(['zoomIn', 'zoomOut', 'zoomReset']);
  // Only shortcuts that do something in this build (tab and page shortcuts arrive with the built-in browser; zoom
  // only once the browser engine offers it, ENGINE-PROTOCOL §4 capabilities).
  const works = (a: ShortcutAction): boolean => shortcutActive(a) && (!ZOOM.has(a) || engineFacts.capabilities.includes('zoom'));
  const groups = $derived(shortcutReference(settings.value.browser.shortcuts, apple, works));
</script>

<section class="section" aria-labelledby="shortcuts">
  <SectionHeader id="shortcuts" variant="title" title="Keyboard shortcuts" description="Your current bindings.">
    {#snippet actions()}
      <a class="link small" href="/settings/shortcuts">Change in Settings</a>
    {/snippet}
  </SectionHeader>

  <div class="groups">
    {#each groups as group (group.id)}
      <div class="group">
        <h3 class="group-title">{group.title}</h3>
        <dl class="rows">
          {#each group.rows as row (row.id)}
            <div class="row">
              <dt>{row.label}</dt>
              <dd>
                {#if row.caps.length === 0}
                  <span class="unbound">Not set</span>
                {:else if row.capsEnd}
                  <span class="range" title={row.spoken}>
                    <span class="sr-only">{row.spoken}</span>
                    <span class="range-caps" aria-hidden="true">
                      <Kbd keys={row.caps} />
                      <span class="to">–</span>
                      <Kbd keys={row.capsEnd.slice(-1)} />
                    </span>
                  </span>
                {:else}
                  <Kbd keys={row.caps} />
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      </div>
    {/each}
  </div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .small {
    font-size: var(--text-sm);
  }

  .groups {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-8);
    align-items: start;
  }

  .group-title {
    padding-bottom: var(--space-2);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    color: var(--text-3);
    border-bottom: 1px solid var(--hairline-strong);
  }

  .rows {
    margin: 0;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 36px;
    padding-block: 5px;
    border-bottom: 1px solid var(--hairline);
  }

  dt {
    color: var(--text-2);
    min-width: 0;
  }

  dd {
    margin: 0;
    flex: none;
  }

  .unbound {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .range-caps {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .to {
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  @media (max-width: 1020px) {
    .groups {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 759px) {
    .groups {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-6);
    }

    /* The title keeps one line: the Settings link moves under the description. */
    .section :global(.section-header) {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2);
    }
  }
</style>
