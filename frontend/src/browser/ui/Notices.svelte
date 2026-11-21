<!--
  Passive notices at the top of the content area:
  - "GNOME was updated — Reload" while a newer service worker waits (ENGINE-PROTOCOL §2.5); with other GNOME tabs
    open it asks to close them first (the update applies only in the only engine host);
  - "Sign in to keep browsing" when a ticket mint needs credentials (§6.5): the button is the only way the dialog
    opens (an engine event never prompts, §1.2 rule 9);
  - the transport's offline states (§6.6) for the active tab's engine.
-->
<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';
  import RefreshCcw from '@lucide/svelte/icons/refresh-ccw';
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import X from '@lucide/svelte/icons/x';
  import Button from '../../components/Button.svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import { browser } from '../browser.svelte';
  import { otherAppPages } from '../session';
  import { describeTransport } from './status-text';

  let updateDismissed = $state(false);
  let others = $state(0);

  $effect(() => {
    if (!browser.updateNotice) return;
    void otherAppPages().then((n) => (others = n));
  });

  const t = $derived(browser.model.active);
  const transport = $derived.by(() => {
    const st = browser.status;
    const engine = t?.engine ?? 'scramjet';
    if (!st || browser.engineState !== 'ready' || !t?.url) return null;
    const side = st.transport[engine];
    const text = describeTransport(side);
    if (!text.blocking || side.detail === 'ticket-missing') return null;
    return text.long;
  });
</script>

<div class="notices" aria-live="polite">
  {#if browser.ticketNotice}
    <div class="notice warn" role="status">
      <Icon icon={KeyRound} size={16} />
      <span class="text">
        {browser.ticketNotice.kind === 'login' ? 'Sign in to keep browsing. This GNOME server only lets signed-in users open pages.' : 'Enter the access code to keep browsing.'}
      </span>
      <Button size="sm" variant="primary" onclick={() => void browser.signIn()}>{browser.ticketNotice.kind === 'login' ? 'Sign in' : 'Enter code'}</Button>
    </div>
  {/if}
  {#if browser.updateNotice && !updateDismissed}
    <div class="notice" role="status">
      <Icon icon={RefreshCcw} size={16} />
      <span class="text">
        GNOME was updated.{others > 0 ? ` Close the other GNOME tabs (${others}), then reload to use the new version.` : ' Reload to use the new version; your tabs come back.'}
      </span>
      <Button size="sm" onclick={() => browser.reloadApp()}>Reload</Button>
      <IconButton icon={X} label="Dismiss" size="sm" onclick={() => (updateDismissed = true)} />
    </div>
  {/if}
  {#if transport}
    <div class="notice danger" role="status">
      <Icon icon={WifiOff} size={16} />
      <span class="text">{transport}</span>
    </div>
  {/if}
</div>

<style>
  .notices {
    position: absolute;
    top: var(--space-3);
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(640px, calc(100% - var(--space-8)));
    pointer-events: none;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    background: color-mix(in oklab, var(--surface-2) 97%, transparent);
    backdrop-filter: var(--glass-filter);
    -webkit-backdrop-filter: var(--glass-filter);
    box-shadow: var(--shadow-pop), var(--glass-inset);
    color: var(--text);
    font-size: var(--text-sm);
    pointer-events: auto;
  }

  .notice :global(svg) {
    flex: none;
    color: var(--text-2);
  }

  .notice.warn :global(svg) {
    color: var(--warning);
  }

  .notice.danger :global(svg) {
    color: var(--danger);
  }

  .text {
    flex: 1;
    line-height: 1.45;
  }
</style>
