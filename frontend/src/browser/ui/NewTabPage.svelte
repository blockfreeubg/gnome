<!--
  A tab without an address (browser.newTab): GNOME's Home ("home"), or a quiet empty page ("blank"). Rendered only
  while the browser view is visible, so Home's own Alt+L handler never focuses a hidden field.
-->
<script lang="ts">
  import Logo from '../../components/Logo.svelte';
  import Kbd from '../../components/Kbd.svelte';
  import HomePage from '../../pages/home/HomePage.svelte';
  import { settings } from '../../settings/store.svelte';

  const EMPTY = new URLSearchParams();
  const mode = $derived(settings.value.browser.newTab);
</script>

<div class="newtab" class:blank-mode={mode === 'blank'}>
  {#if mode === 'blank'}
    <div class="blank">
      <Logo size={40} decorative />
      <p>Type an address or a search in the address bar <Kbd action="focusOmnibox" /></p>
    </div>
  {:else}
    <HomePage params={{}} query={EMPTY} />
  {/if}
</div>

<style>
  /* Home mode is see-through: the shell paints Home's backdrop behind the whole window (shell.backdrop). */
  .newtab {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    z-index: 1;
  }

  .newtab.blank-mode {
    background: var(--bg);
  }

  .blank {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    color: var(--text-3);
    font-size: var(--text-sm);
    opacity: 0.85;
  }
</style>
