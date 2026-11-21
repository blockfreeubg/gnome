<!--
  About: the artwork and versions, how GNOME works, privacy (what is stored where + proxy isolation), keyboard
  shortcuts, diagnostics, the AGPL source offer and the open-source license list. Works without the server: every
  server-provided value (versions, isolation, source link, served filter lists) degrades to an explanation.
-->
<script lang="ts">
  import PageHeader from '../../components/PageHeader.svelte';
  import type { PageProps } from '../../app/routes';
  import { isFeatureActive } from '../../settings/features';
  import AboutHero from './AboutHero.svelte';
  import BlockingSection from './BlockingSection.svelte';
  import DiagnosticsSection from './DiagnosticsSection.svelte';
  import EngineSection from './EngineSection.svelte';
  import HowItWorks from './HowItWorks.svelte';
  import LicensesSection from './LicensesSection.svelte';
  import PrivacySection from './PrivacySection.svelte';
  import ShortcutsSection from './ShortcutsSection.svelte';
  import SourceSection from './SourceSection.svelte';

  let {}: PageProps = $props();

  const blocking = $derived(isFeatureActive('extensions'));
  const toc: ReadonlyArray<{ id: string; label: string }> = $derived([
    { id: 'how-it-works', label: 'How it works' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'engine', label: 'Browser engine' },
    ...(blocking ? [{ id: 'blocking', label: 'Content blocking' }] : []),
    { id: 'shortcuts', label: 'Keyboard shortcuts' },
    { id: 'diagnostics', label: 'Diagnostics' },
    { id: 'source', label: 'Source code' },
    { id: 'licenses', label: 'Licenses' },
  ]);
</script>

<div class="page narrow about">
  <PageHeader
    title="About"
    description="What GNOME is, how it treats your data, and the open-source software it is built on."
  />

  <AboutHero />

  <div class="layout">
    <div class="sections">
      <HowItWorks />
      <PrivacySection />
      <EngineSection />
      {#if blocking}<BlockingSection />{/if}
      <ShortcutsSection />
      <DiagnosticsSection />
      <SourceSection />
      <LicensesSection />
    </div>

    <nav class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      <ul>
        {#each toc as item (item.id)}
          <li><a href={`#${item.id}`}>{item.label}</a></li>
        {/each}
      </ul>
    </nav>
  </div>
</div>

<style>
  .about {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 188px;
    gap: var(--space-6);
    align-items: start;
  }

  .sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }

  /* Each section is a glass card (DESIGN.md §12). */
  .sections > :global(.section) {
    padding: var(--space-8);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
    min-width: 0;
  }

  /* Section headings land below the top edge when reached through the table of contents. */
  .sections :global([id]) {
    scroll-margin-top: var(--space-8);
  }

  /* Table of contents as a small navigation card, like the settings navigation. */
  .toc {
    position: sticky;
    top: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-2) var(--space-2);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-raise);
  }

  .toc-title {
    margin: 0;
    padding: 0 var(--space-2) var(--space-1);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    color: var(--text-3);
  }

  .toc ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .toc a {
    display: flex;
    align-items: center;
    min-height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius);
    color: var(--text-2);
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    transition:
      color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out);
  }

  .toc a:hover {
    color: var(--text);
    background: var(--hover);
  }

  @media (max-width: 1100px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .toc {
      display: none;
    }
  }

  @media (max-width: 759px) {
    .about {
      gap: var(--space-4);
    }

    .sections {
      gap: var(--space-4);
    }

    .sections > :global(.section) {
      padding: var(--space-6) var(--space-5);
    }
  }
</style>
