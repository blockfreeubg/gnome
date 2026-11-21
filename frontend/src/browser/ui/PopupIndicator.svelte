<!--
  "Pop-up blocked" indicator (ENGINE-PROTOCOL §6.3): pop-ups a page asked for without a gesture wait here. Opening
  one from this panel is a click in GNOME's own UI; for sites set to "ask", Allow / Block remembers the choice.
-->
<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import PictureInPicture from '@lucide/svelte/icons/picture-in-picture-2';
  import X from '@lucide/svelte/icons/x';
  import Button from '../../components/Button.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Popover from '../../components/Popover.svelte';
  import { displayUrl, hostOf } from '../../lib/url';
  import { browser } from '../browser.svelte';
  import type { Tab } from '../tabs.svelte';

  let { tab }: { tab: Tab } = $props();
  let anchor = $state<HTMLElement>();
  let open = $state(false);
  const site = $derived(tab.url ? hostOf(tab.url) : '');
  const ask = $derived(tab.url ? browser.popupDecisionFor(tab.url) === 'ask' : false);
</script>

<span bind:this={anchor} class="wrap">
  <IconButton
    icon={PictureInPicture}
    label={`Pop-up blocked (${tab.blockedPopups.length})`}
    tooltipPlacement="bottom"
    class="popup-btn"
    pressed={open}
    onclick={() => (open = !open)}
  />
</span>

<Popover class="browser-pop" bind:open {anchor} label="Blocked pop-ups" placement="bottom-end" width="340px">
  <div class="panel">
    <h3 class="title">Pop-ups blocked on {site || 'this page'}</h3>
    <ul role="list">
      {#each tab.blockedPopups as p (p.url + p.at)}
        <li>
          <span class="url mono" title={p.url}>{displayUrl(p.url)}</span>
          <IconButton icon={ExternalLink} label="Open in new tab" size="sm" onclick={() => {
            browser.openBlockedPopup(tab.id, p.url);
            if (tab.blockedPopups.length === 0) open = false;
          }} />
        </li>
      {/each}
    </ul>
    <div class="actions">
      {#if ask && tab.url}
        <Button size="sm" onclick={() => {
          if (tab.url) browser.setPopupPermission(tab.url, 'allow');
          open = false;
        }}>Always allow on {site}</Button>
        <Button size="sm" variant="ghost" onclick={() => {
          if (tab.url) browser.setPopupPermission(tab.url, 'block');
          tab.blockedPopups = [];
          open = false;
        }}>Always block</Button>
      {:else}
        <Button size="sm" variant="ghost" icon={X} onclick={() => {
          tab.blockedPopups = [];
          open = false;
        }}>Dismiss</Button>
      {/if}
    </div>
  </div>
</Popover>

<style>
  .wrap {
    display: inline-flex;
  }

  .wrap :global(.popup-btn) {
    color: var(--warning);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  .title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
  }

  ul {
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    border-bottom: 1px solid var(--hairline);
  }

  .url {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--text-2);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
