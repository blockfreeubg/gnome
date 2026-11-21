<!--
  Phone tab switcher (DESIGN.md §9: under 760px the tab strip becomes a sheet): every tab with its title and
  address, the active one marked; tap to switch, × to close, and a new-tab button.
-->
<script lang="ts">
  import Globe from '@lucide/svelte/icons/globe';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import Button from '../../components/Button.svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import { displayUrl } from '../../lib/url';
  import { browser } from '../browser.svelte';
  import { addressOf, faviconOf, titleOf } from './util';

  let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Sheet bind:open side="bottom" title={`Tabs (${browser.model.tabs.length})`} size="80dvh" onclose={() => (open = false)}>
  <ul class="list" role="list">
    {#each browser.model.tabs as t (t.id)}
      <li class:active={t.id === browser.model.activeId}>
        <button
          type="button"
          class="pick"
          aria-current={t.id === browser.model.activeId ? 'true' : undefined}
          onclick={() => {
            browser.activate(t.id);
            open = false;
          }}
        >
          <span class="icon">
            {#if faviconOf(t)}<img src={faviconOf(t)} alt="" width="18" height="18" />{:else}<Icon icon={Globe} size={16} />{/if}
          </span>
          <span class="text">
            <span class="title">{titleOf(t)}</span>
            {#if addressOf(t)}<span class="url mono">{displayUrl(addressOf(t)!)}</span>{/if}
          </span>
        </button>
        <IconButton icon={X} label={`Close ${titleOf(t)}`} size="sm" onclick={() => browser.close(t.id)} />
      </li>
    {/each}
  </ul>
  {#snippet footer()}
    <Button variant="primary" icon={Plus} full onclick={() => {
      browser.newTab();
      open = false;
    }}>New tab</Button>
  {/snippet}
</Sheet>

<style>
  .list {
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    border-bottom: 1px solid var(--hairline);
  }

  li.active .icon {
    color: var(--text);
    background: var(--selected);
    border-color: var(--selected-ring);
  }

  li.active .title {
    font-weight: 600;
  }

  .pick {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 52px;
    padding: var(--space-2) 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: var(--radius);
    border: 1px solid var(--hairline);
    color: var(--text-3);
  }

  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .title,
  .url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .url {
    font-size: var(--text-xs);
    color: var(--text-3);
  }
</style>
