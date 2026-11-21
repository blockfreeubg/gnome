<!-- How GNOME works: the request path and the four building blocks (docs/ARCHITECTURE.md §1, §4.6). -->
<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Cable from '@lucide/svelte/icons/cable';
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import Server from '@lucide/svelte/icons/server';
  import Workflow from '@lucide/svelte/icons/workflow';
  import Icon from '../../components/Icon.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';

  interface Block {
    icon: LucideIcon;
    title: string;
    body: string;
  }

  const blocks: readonly Block[] = [
    {
      icon: Columns2,
      title: 'Two origins',
      body: 'The GNOME app, your settings and the API live on the app origin. Sites you open run in an engine host on a separate proxy origin, so a hostile page cannot read GNOME’s data. The two only talk through a small, origin-checked message channel.',
    },
    {
      icon: Workflow,
      title: 'Proxy engines',
      body: 'Scramjet is the main engine and Ultraviolet the fallback. Both run in your browser: a service worker rewrites each page so its requests go through GNOME instead of straight to the site.',
    },
    {
      icon: Cable,
      title: 'HolyWisp',
      body: 'Connections travel over Wisp, which carries many TCP streams in one WebSocket. HolyWisp, a small Wisp server written in C, opens them and refuses private and local addresses. TLS is negotiated in your browser, so for HTTPS sites the server only relays encrypted bytes.',
    },
    {
      icon: Server,
      title: 'Rust backend',
      body: 'gnome-server is a single Rust binary built on Axum and Tokio. It serves the app and the API, keeps accounts, sync and the games catalog in SQLite, and checks a short-lived Wisp ticket before it hands a connection to HolyWisp.',
    },
  ];

  const path: ReadonlyArray<{ label: string; detail: string }> = [
    { label: 'Your browser', detail: 'GNOME app · engine host' },
    { label: 'gnome-server', detail: 'Wisp gateway' },
    { label: 'HolyWisp', detail: 'egress policy' },
    { label: 'The site', detail: 'HTTPS from your browser' },
  ];
</script>

<section class="section" aria-labelledby="how-it-works">
  <SectionHeader
    id="how-it-works"
    variant="title"
    title="How it works"
    description="What happens between the address bar and the page you see."
  />

  <ol class="path" aria-label="Path of a proxied request">
    {#each path as step, i (step.label)}
      <li class="step">
        <span class="step-label">{step.label}</span>
        <span class="step-detail">{step.detail}</span>
      </li>
      {#if i < path.length - 1}
        <li class="arrow" aria-hidden="true"><Icon icon={ArrowRight} size={16} /></li>
      {/if}
    {/each}
  </ol>

  <div class="blocks">
    {#each blocks as block (block.title)}
      <article class="block">
        <h3 class="block-title"><Icon icon={block.icon} size={18} /> {block.title}</h3>
        <p>{block.body}</p>
      </article>
    {/each}
  </div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .path {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
    list-style: none;
    margin: 0;
    padding: var(--space-4);
    border: 1px solid var(--field-border);
    border-radius: var(--radius-lg);
    background: var(--field-bg);
  }

  .step {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
  }

  .step-label {
    font-weight: 600;
    color: var(--text);
  }

  .step-detail {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .arrow {
    display: grid;
    place-items: center;
    color: var(--text-3);
    flex: none;
  }

  .blocks {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: var(--space-10);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-5);
    border-top: 1px solid var(--hairline);
  }

  .block-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
  }

  .block-title :global(svg) {
    color: var(--text-2);
  }

  .block p {
    color: var(--text-2);
    line-height: 1.6;
  }

  @media (max-width: 759px) {
    .path {
      flex-direction: column;
      gap: 0;
      padding: var(--space-2) var(--space-3);
    }

    .step {
      padding: var(--space-2) 0;
    }

    .arrow {
      justify-content: start;
      padding-left: 2px;
      transform: rotate(90deg);
      width: 16px;
      height: 16px;
    }

    .blocks {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
