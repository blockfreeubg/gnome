<!--
  The content area while the browser engine cannot show the active page: starting, did not start (Retry), GNOME was
  updated (Reload) or not responding (Restart). Every button is a gesture in GNOME's own UI; Retry and Restart
  replace the engine iframe instead of re-navigating it (ENGINE-PROTOCOL §2.3).
-->
<script lang="ts">
  import RefreshCcw from '@lucide/svelte/icons/refresh-ccw';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Button from '../../components/Button.svelte';
  import Logo from '../../components/Logo.svelte';
  import ProgressBar from '../../components/ProgressBar.svelte';
  import { browser } from '../browser.svelte';

  const state = $derived(browser.engineState);
  // The client's own hello timeout says what the heading already says: explain it instead (a late first hello from the
  // same engine iframe still connects, ENGINE-PROTOCOL §2.2 step 5). Other details (e.g. the server is not reachable)
  // are shown as they are.
  const failedText = $derived(
    !browser.engineDetail || /^The browser engine did not start\.?$/.test(browser.engineDetail)
      ? 'It did not answer in time. It may still finish starting by itself; Retry starts it again.'
      : browser.engineDetail,
  );
</script>

<div class="engine-state" role={state === 'starting' || state === 'connecting' ? 'status' : 'alert'}>
  <div class="card glass-card">
    <Logo size={40} decorative />
    {#if state === 'starting' || state === 'connecting' || state === 'idle'}
      <h2>Starting the browser engine</h2>
      <p>Loading Scramjet and Ultraviolet and connecting to GNOME’s gateway.</p>
      <div class="bar"><ProgressBar label="Starting the browser engine" size="xs" /></div>
    {:else if state === 'failed'}
      <h2>The browser engine did not start</h2>
      <p>{failedText}</p>
      <div class="actions"><Button variant="primary" icon={RotateCw} onclick={() => browser.restartEngine('retry')}>Retry</Button></div>
    {:else if state === 'mismatch'}
      <h2>GNOME was updated</h2>
      <p>This page is from an older version of GNOME than its browser engine. Reload to keep browsing; your tabs come back.</p>
      <div class="actions"><Button variant="primary" icon={RefreshCcw} onclick={() => browser.reloadApp()}>Reload GNOME</Button></div>
    {:else if state === 'unresponsive'}
      <h2>The browser engine is not responding</h2>
      <p>A page may be busy running a long script. Restarting reloads your open tabs.</p>
      <div class="actions"><Button variant="primary" icon={RotateCw} onclick={() => browser.restartEngine('restart')}>Restart browser engine</Button></div>
    {/if}
  </div>
</div>

<style>
  .engine-state {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--space-8) var(--space-6);
    background: var(--bg);
    z-index: 3;
  }

  .card {
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: 32px 28px 28px;
    text-align: center;
  }

  h2 {
    margin-top: var(--space-2);
    font-family: var(--font-display);
    font-size: 1.43rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.2;
    color: var(--text);
  }

  p {
    color: var(--text-2);
    font-size: 0.9286rem;
    line-height: 1.6;
  }

  .bar {
    width: 200px;
    margin-top: var(--space-2);
  }

  .actions {
    align-self: stretch;
    margin-top: var(--space-2);
  }

  .actions :global(.btn) {
    width: 100%;
    height: var(--control-h-lg);
    border-radius: var(--radius-lg);
  }
</style>
