<!--
  Diagnostics summary from the status registry (src/app/status.ts): one row per subsystem with its state and detail,
  plus "Check server again" (server.refresh) and "Copy diagnostics" (the same JSON as the command palette's command).
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Button from '../../components/Button.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';
  import { copyDiagnostics } from '../../app/builtin';
  import { server } from '../../app/server.svelte';
  import { allStatuses } from '../../app/status';
  import { formatRelativeTime } from '../../lib/format';
  import { stateLabel, statusTone, subsystemLabel } from './about';

  const statuses = $derived(allStatuses());

  let now = $state(Date.now());
  let checking = $state(false);

  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  async function checkAgain(): Promise<void> {
    checking = true;
    try {
      await server.refresh();
    } finally {
      checking = false;
      now = Date.now();
    }
  }

  const checkedLine = $derived(
    server.lastCheckedAt === null ? 'Not checked yet' : `Server checked ${formatRelativeTime(server.lastCheckedAt, now)}`,
  );
</script>

<section class="section" aria-labelledby="diagnostics">
  <SectionHeader
    id="diagnostics"
    variant="title"
    title="Diagnostics"
    description="How each part of GNOME is doing in this browser. Useful when something does not work."
  />

  {#if statuses.length === 0}
    <p class="empty">No subsystem has reported its status yet.</p>
  {:else}
    <ul class="list">
      {#each statuses as [name, status] (name)}
        <li class="item">
          <span class="name">{subsystemLabel(name)}</span>
          <span class="state {statusTone(status.state)}">
            <span class="dot" aria-hidden="true"></span>{stateLabel(status.state)}
          </span>
          <span class="detail">{status.detail ?? ''}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="footer">
    <p class="checked" aria-live="polite">{checkedLine}</p>
    <div class="actions">
      <Button variant="ghost" size="sm" icon={RefreshCw} loading={checking} onclick={checkAgain}>Check server again</Button>
      <Button variant="secondary" size="sm" icon={Copy} onclick={() => void copyDiagnostics()}>Copy diagnostics</Button>
    </div>
  </div>
  <p class="note">Copied diagnostics contain versions and subsystem status only, never pages you visited.</p>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }

  .item {
    display: grid;
    grid-template-columns: minmax(120px, 0.9fr) 110px minmax(0, 3fr);
    align-items: baseline;
    gap: var(--space-4);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--hairline);
  }

  .name {
    font-weight: 600;
    color: var(--text);
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    flex: none;
    align-self: center;
  }

  .success .dot {
    background: var(--success);
  }
  .warning .dot {
    background: var(--warning);
  }
  .danger .dot {
    background: var(--danger);
  }
  .slate .dot {
    background: var(--slate);
  }

  .detail {
    color: var(--text-2);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .empty {
    color: var(--text-3);
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .checked {
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .note {
    margin-top: calc(-1 * var(--space-2));
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  @media (max-width: 759px) {
    .item {
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 4px;
    }

    .detail {
      grid-column: 1 / -1;
    }
  }
</style>
