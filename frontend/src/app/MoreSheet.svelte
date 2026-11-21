<!-- "More" sheet for the mobile bottom bar: destinations that do not fit in the bar, plus search. -->
<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Search from '@lucide/svelte/icons/search';
  import Icon from '../components/Icon.svelte';
  import { router } from './router.svelte';
  import { mobileNav, pathFor } from './routes';
  import { shell } from './shell.svelte';

  interface Props {
    close: () => void;
  }

  let { close }: Props = $props();

  const routes = $derived(mobileNav().more);
</script>

<ul class="more" role="list">
  <li>
    <button
      type="button"
      class="row"
      onclick={() => {
        close();
        shell.openPalette();
      }}
    >
      <span class="icon"><Icon icon={Search} size={18} /></span>
      <span class="text">Search and commands</span>
    </button>
  </li>
  {#each routes as r (r.id)}
    <li>
      <a href={pathFor(r.id)} class="row" aria-current={router.isActive(r.id) ? 'page' : undefined} onclick={close}>
        <span class="icon"><Icon icon={r.nav.icon} size={18} /></span>
        <span class="text">
          <span class="title">{r.nav.label}</span>
          {#if r.description}<span class="desc">{r.description}</span>{/if}
        </span>
        <Icon icon={ChevronRight} size={16} class="chev" />
      </a>
    </li>
  {/each}
</ul>

<style>
  .more {
    margin: 0;
    padding: 0;
  }

  li + li {
    border-top: 1px solid var(--hairline);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 56px;
    padding: 8px 4px;
    color: var(--text);
    text-align: left;
  }

  .row:hover .icon {
    color: var(--text);
    border-color: var(--hairline-strong);
  }

  .row[aria-current='page'] .icon {
    color: var(--text);
    background: var(--selected);
    border-color: var(--selected-ring);
  }

  .icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: var(--radius);
    border: 1px solid var(--hairline);
    color: var(--text-2);
    transition:
      color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out);
  }

  .text {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .title {
    font-weight: 500;
  }

  .desc {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .row :global(.chev) {
    color: var(--text-3);
  }
</style>
