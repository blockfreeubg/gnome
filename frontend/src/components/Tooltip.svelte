<!-- Shared tooltip layer. Mount once (the app shell does); triggers use the `tooltip` attachment. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { autoPosition, topLayer } from './floating';
  import { fade } from './motion';
  import { hideTooltip, keepTooltip, releaseTooltip, TOOLTIP_ID, tooltipState } from './tooltip.svelte';
  import Kbd from './Kbd.svelte';

  function position(node: HTMLElement): (() => void) | undefined {
    const anchor = tooltipState.anchor;
    if (!anchor) return undefined;
    return autoPosition(anchor, node, tooltipState.placement, { offset: 8, padding: 6 });
  }

  // Every rendered tooltip element and the trigger it was made for. A tooltip that is fading out (moving between
  // triggers, or hiding) must drop its id in the same update that renders the next one: Svelte only fires
  // `outrostart` a frame later, and for that frame two elements would carry #gnome-tooltip.
  const owners = new Map<HTMLElement, HTMLElement | null>();

  function track(node: HTMLElement): () => void {
    owners.set(node, untrack(() => tooltipState.anchor));
    return () => owners.delete(node);
  }

  $effect(() => {
    const current = tooltipState.visible ? tooltipState.anchor : null;
    for (const [node, anchor] of owners) if (anchor !== current) node.removeAttribute('id');
  });
</script>

<!-- Escape dismisses a visible tooltip wherever focus is (WCAG 1.4.13); the key still reaches everything else. -->
<svelte:window
  onkeydowncapture={(ev) => {
    if (ev.key === 'Escape' && tooltipState.visible) hideTooltip();
  }}
/>

<!-- A tooltip fading out (moving between triggers) drops its id at once: the id belongs to the one being shown. -->
{#if tooltipState.visible && tooltipState.anchor}
  {#key tooltipState.anchor}
    <div
      id={TOOLTIP_ID}
      class="tooltip"
      role="tooltip"
      onpointerenter={keepTooltip}
      onpointerleave={releaseTooltip}
      onoutrostart={(ev) => ev.currentTarget.removeAttribute('id')}
      {@attach track}
      {@attach topLayer}
      {@attach position}
      transition:fade={{ duration: 90 }}
    >
      <span>{tooltipState.text}</span>
      {#if tooltipState.shortcut || tooltipState.action}
        <Kbd combo={tooltipState.shortcut} action={tooltipState.action} />
      {/if}
    </div>
  {/key}
{/if}

<style>
  .tooltip {
    position: fixed;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 280px;
    padding: 5px 9px;
    border-radius: calc(var(--radius-sm) + 2px);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--shadow-pop);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.35;
    white-space: nowrap;
  }

  /* The shortcut hint inside reads quietly (DESIGN.md §10 Tooltip). */
  .tooltip :global(.kbd) {
    color: var(--text-3);
  }
</style>
