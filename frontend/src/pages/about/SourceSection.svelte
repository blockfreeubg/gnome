<!--
  AGPL §13 source offer: the link comes from GET /api/config → source_url (GNOME_SOURCE_URL). Without one, the
  section says so and tells operators how to set it; with the server offline it says the link is unavailable.
-->
<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Button from '../../components/Button.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';
  import { server } from '../../app/server.svelte';
  import { sourceOffer } from './about';
  import { LICENSES, GNOME_LICENSE } from './licenses';

  const offer = $derived(sourceOffer(server.config));
  const license = LICENSES[GNOME_LICENSE];
</script>

<section class="section" aria-labelledby="source">
  <SectionHeader id="source" variant="title" title="Source code" />

  <p class="lead">
    GNOME is free software under the
    <a class="link" href={license.url} target="_blank" rel="external noopener noreferrer">{license.name}</a>. Everyone who
    uses it over a network is entitled to the complete source code of the version this server runs.
  </p>

  {#if offer.kind === 'link'}
    <div class="offer">
      <Button variant="primary" href={offer.url} target="_blank" rel="external noopener noreferrer" iconEnd={ExternalLink}>
        Get the source code
      </Button>
      <span class="url mono">{offer.url}</span>
    </div>
  {:else if offer.kind === 'missing'}
    <div class="notice">
      <p class="notice-title">This server has not published a link to its source code.</p>
      <p>
        If you run it: set <code class="mono">GNOME_SOURCE_URL</code> to the address where the source of this deployment,
        including your changes, can be downloaded. The AGPL requires offering it to everyone who uses the server, and
        this page will show the link.
      </p>
    </div>
  {:else}
    <p class="muted-note">
      The link to the source code comes from the GNOME server, which {server.reachable === null ? 'is still being contacted' : 'is not reachable right now'}.
    </p>
  {/if}
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .lead {
    max-width: 72ch;
    color: var(--text-2);
    line-height: 1.6;
  }

  .offer {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .url {
    font-size: var(--text-sm);
    color: var(--text-3);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 80ch;
    padding: var(--space-4) var(--space-5);
    border: 1px solid color-mix(in oklab, var(--warning) 35%, var(--field-border));
    border-radius: var(--radius-lg);
    background: var(--field-bg);
    color: var(--text-2);
    line-height: 1.55;
  }

  .notice-title {
    color: var(--text);
    font-weight: 600;
  }

  code {
    font-size: 0.92em;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    color: var(--text);
  }

  .muted-note {
    color: var(--text-3);
  }
</style>
