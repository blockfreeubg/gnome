<!--
  Engine badge (DESIGN.md §8 "SJ"/"UV"): which proxy engine shows the active tab, with a spinner while its transport
  (re)connects. Opens a panel with the engines' and transports' state, "Reload with <other engine>" and
  "Restart browser engine".
-->
<script lang="ts">
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Button from '../../components/Button.svelte';
  import Popover from '../../components/Popover.svelte';
  import Spinner from '../../components/Spinner.svelte';
  import { tooltip } from '../../components/tooltip.svelte';
  import type { EngineId, TransportStatus } from '../../shared/engine-protocol';
  import { browser, engineLabel, otherEngine } from '../browser.svelte';
  import { describeTransport } from './status-text';
  import { ENGINE_SHORT } from './util';

  let anchor = $state<HTMLButtonElement>();
  let open = $state(false);

  const t = $derived(browser.model.active);
  const status = $derived(browser.status);
  const engine = $derived<EngineId | null>(t?.engine ?? null);
  const side = $derived<TransportStatus | null>(engine && status ? status.transport[engine] : null);
  const busy = $derived(browser.engineState === 'starting' || browser.engineState === 'connecting' || side?.state === 'connecting');
  const trouble = $derived(side?.state === 'offline' || browser.engineState === 'failed' || browser.engineState === 'unresponsive');
  const label = $derived(engine ? `${engineLabel(engine)}${side ? `, ${describeTransport(side).short}` : ''}` : 'Browser engine');
</script>

<button
  bind:this={anchor}
  type="button"
  class="badge"
  class:trouble
  aria-label={`Proxy engine: ${label}`}
  aria-expanded={open}
  aria-haspopup="dialog"
  onclick={() => (open = !open)}
  {@attach tooltip({ text: `Proxy engine: ${label}`, placement: 'bottom' })}
>
  {#if busy}
    <Spinner size={12} />
  {:else}
    <span class="dot" aria-hidden="true"></span>
  {/if}
  <span class="mono">{engine ? ENGINE_SHORT[engine] : '—'}</span>
</button>

<Popover class="browser-pop" bind:open {anchor} label="Browser engine" placement="bottom-end" width="320px">
  <div class="panel">
    <h3 class="eyebrow">Browser engine</h3>
    {#if browser.engineState === 'idle'}
      <p class="muted">Starts with the first page you open.</p>
    {:else if status}
      <ul role="list">
        {#each ['scramjet', 'ultraviolet'] as const as id (id)}
          {@const e = status.engines[id]}
          {@const tr = describeTransport(status.transport[id])}
          <li class:current={engine === id}>
            <span class="name">{engineLabel(id)} <span class="ver mono">{e.version}</span></span>
            <span class="state" class:bad={e.state === 'failed' || status.transport[id].state === 'offline'}>
              {e.state === 'ready' ? tr.short : e.state === 'disabled' ? 'Turned off on this server' : e.state === 'failed' ? 'Failed to start' : 'Starting'}
            </span>
            {#if tr.long && e.state === 'ready'}<span class="detail">{tr.long}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">{browser.engineDetail ?? 'Starting…'}</p>
    {/if}
    <p class="note">The address bar shows what the page reports. It is not proof of a site’s identity.</p>
    <div class="actions">
      {#if t?.url && engine && status?.engines[otherEngine(engine)].state === 'ready'}
        <Button
          size="sm"
          onclick={() => {
            open = false;
            if (t) browser.retry(t.id, otherEngine(engine));
          }}>Reload with {engineLabel(otherEngine(engine))}</Button
        >
      {/if}
      {#if browser.engineState !== 'idle'}
        <Button size="sm" variant="ghost" icon={RotateCw} onclick={() => {
          open = false;
          browser.restartEngine('restart');
        }}>Restart engine</Button>
      {/if}
    </div>
  </div>
</Popover>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    margin: 0 2px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition:
      border-color var(--t-1) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .badge:hover {
    color: var(--text);
    border-color: var(--text-3);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--moss);
  }

  .badge.trouble .dot {
    background: var(--danger);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  ul {
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }

  li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--hairline);
    font-size: var(--text-sm);
  }

  li.current .name {
    color: var(--accent-strong);
  }

  .ver {
    color: var(--text-3);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .state {
    color: var(--text-2);
    text-align: right;
  }

  .state.bad {
    color: var(--danger);
  }

  .detail {
    grid-column: 1 / -1;
    color: var(--text-3);
    font-size: var(--text-xs);
  }

  .muted,
  .note {
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .note {
    font-size: var(--text-xs);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
