<!--
  Open-source licenses: every third-party component GNOME ships (data in ./licenses.ts). When the server lists the
  filter lists it actually distributes (GET /api/filters), those replace the documented defaults.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Icon from '../../components/Icon.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';
  import { server } from '../../app/server.svelte';
  import { request } from '../../lib/api';
  import { isFeatureActive } from '../../settings/features';
  import LicenseExpression from './LicenseExpression.svelte';
  import {
    COMPONENT_GROUPS,
    RUST_CRATES,
    crateLicenseSummary,
    licenseLabel,
    type Component,
  } from './licenses';

  interface ServedList {
    id: string;
    name: string;
    license: string;
    homepage: string;
  }

  let served = $state<ServedList[] | null>(null);
  let requested = false;

  /**
   * Filter lists this server distributes (`lists`, plus the redirect resources and scriptlets it serves as
   * `resources`); only plain fields are kept and links must be http(s).
   */
  function parseLists(body: unknown): ServedList[] {
    const b = body as { lists?: unknown; resources?: unknown } | null;
    if (!Array.isArray(b?.lists)) return [];
    const all: unknown[] = b.resources && typeof b.resources === 'object' ? [...b.lists, b.resources] : b.lists;
    const out: ServedList[] = [];
    for (const raw of all) {
      if (!raw || typeof raw !== 'object') continue;
      const l = raw as Record<string, unknown>;
      if (typeof l.id !== 'string' || typeof l.name !== 'string') continue;
      let homepage = '';
      if (typeof l.homepage === 'string') {
        try {
          const u = new URL(l.homepage);
          if (u.protocol === 'https:' || u.protocol === 'http:') homepage = u.href;
        } catch {
          /* not a URL: shown without a link */
        }
      }
      out.push({ id: l.id, name: l.name, license: typeof l.license === 'string' ? l.license : '', homepage });
    }
    return out;
  }

  $effect(() => {
    if (server.reachable !== true || requested) return;
    requested = true;
    request<unknown>('/api/filters', { timeoutMs: 8000 })
      .then((body) => {
        const lists = parseLists(body);
        if (lists.length) served = lists;
      })
      .catch(() => {
        /* Older server or filters module off: the documented defaults stay. */
      });
  });

  /** Groups this build ships (engines and blocking arrive with their features). */
  const shipped = $derived(COMPONENT_GROUPS.filter((g) => !g.needs || isFeatureActive(g.needs)));
  const componentCount = $derived(
    shipped.reduce((n, g) => n + (g.id === 'filter-lists' && served ? served.length : g.components.length), 0),
  );
  const crateSummary = crateLicenseSummary();

  function credit(c: Component): string {
    return c.copyright ?? (c.author ? `By ${c.author}` : '');
  }
</script>

{#snippet componentRow(c: Component)}
  <li class="comp">
    <div class="head">
      <a class="comp-name" href={c.url} target="_blank" rel="external noopener noreferrer">{c.name}</a>
      {#if c.version}<span class="ver mono">{c.version}</span>{/if}
    </div>
    <p class="lic-line"><LicenseExpression expression={c.license} /></p>
    {#if c.note}<p class="note">{c.note}</p>{/if}
    {#if credit(c)}<p class="credit">{credit(c)}</p>{/if}
    {#if c.includes?.length}
      <div class="includes">
        <span class="inc-label">Includes</span>
        <ul class="inc-list">
          {#each c.includes as inc (inc.name)}
            <li>
              {#if inc.url}<a href={inc.url} target="_blank" rel="external noopener noreferrer">{inc.name}</a>{:else}<span
                  >{inc.name}</span
                >{/if}
              <span class="inc-lic">({licenseLabel(inc.license)})</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </li>
{/snippet}

<section class="section" aria-labelledby="licenses">
  <SectionHeader
    id="licenses"
    variant="title"
    title="Open-source licenses"
    description={`GNOME is built on ${componentCount} open-source components and ${RUST_CRATES.length} Rust crates. Thank you to everyone who made them. Open-source games are not part of GNOME: each keeps its own license, shown on its own game page.`}
  />

  {#each shipped as group (group.id)}
    {#if group.id === 'filter-lists' && served}
      <!-- The lists this server really distributes replace the documented defaults. -->
      <div class="group">
        <div class="group-head">
          <h3 class="group-title">Filter lists</h3>
          <p class="group-desc">
            The lists this server distributes, as it reports them. Each list keeps its own license and attribution.
          </p>
        </div>
        <ul class="comps">
          {#each served as l (l.id)}
            <li class="comp">
              <div class="head">
                {#if l.homepage}
                  <a class="comp-name" href={l.homepage} target="_blank" rel="external noopener noreferrer">{l.name}</a>
                {:else}
                  <span class="comp-name">{l.name}</span>
                {/if}
              </div>
              <p class="lic-line">
                {#if l.license}<LicenseExpression expression={l.license} />{:else}<span class="note">License not reported</span>{/if}
              </p>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <div class="group">
        <div class="group-head">
          <h3 class="group-title">{group.title}</h3>
          <p class="group-desc">{group.description}</p>
        </div>
        <ul class="comps">
          {#each group.components as c (c.id)}
            {@render componentRow(c)}
          {/each}
        </ul>
      </div>
    {/if}
  {/each}

  <details class="crates">
    <summary>
      <span class="sum-main">
        <Icon icon={ChevronDown} size={16} class="chev" />
        <span class="sum-title">Rust crates in gnome-server</span>
        <span class="sum-count tabular">{RUST_CRATES.length}</span>
      </span>
      <span class="sum-licenses">
        {#each crateSummary as s, i (s.license)}
          <span>{licenseLabel(s.license)} <span class="tabular n">({s.count})</span></span>{#if i < crateSummary.length - 1}<span
              class="sep"
              aria-hidden="true">·</span
            >{/if}
        {/each}
      </span>
    </summary>
    <ul class="crate-grid">
      {#each RUST_CRATES as crate (`${crate.name}@${crate.version}`)}
        <li class="crate">
          <a
            class="crate-name mono"
            href={`https://crates.io/crates/${crate.name}/${crate.version}`}
            target="_blank"
            rel="external noopener noreferrer">{crate.name}</a
          >
          <span class="crate-ver mono tabular">{crate.version}</span>
          <span class="crate-lic"><LicenseExpression expression={crate.license} short /></span>
        </li>
      {/each}
    </ul>
  </details>

  <p class="footnote">
    Build and test tools (Vite, TypeScript, Vitest, Playwright and their dependencies) are not shipped to you and are not
    listed.{isFeatureActive('browser') ? ' The proxy engines are served exactly as their authors published them.' : ''}
  </p>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }

  .group {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-3);
    padding-top: var(--space-6);
    border-top: 1px solid var(--hairline);
  }

  .group-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 72ch;
  }

  .group-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--text-lg);
    letter-spacing: var(--tracking-heading);
    color: var(--text);
  }

  .group-desc {
    font-size: var(--text-sm);
    color: var(--text-3);
    line-height: 1.55;
  }

  .comps {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: var(--space-8);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .comp {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--space-3) 0 var(--space-4);
    border-bottom: 1px solid var(--hairline);
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .comp-name {
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
  }

  a.comp-name:hover {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 0.18em;
  }

  .ver {
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .lic-line {
    font-size: var(--text-sm);
  }

  .note {
    font-size: var(--text-sm);
    color: var(--text-2);
    line-height: 1.5;
  }

  .credit {
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .includes {
    font-size: var(--text-xs);
    color: var(--text-3);
    line-height: 1.6;
  }

  .includes a {
    color: var(--text-2);
    text-decoration: underline;
    text-decoration-color: var(--hairline-strong);
    text-underline-offset: 0.18em;
  }

  .includes a:hover {
    color: var(--accent-strong);
  }

  .inc-label {
    font-weight: 600;
    margin-right: 4px;
  }

  .inc-list {
    display: inline;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .inc-list li {
    display: inline;
  }

  .inc-list li:not(:last-child)::after {
    content: ', ';
  }

  .crates {
    border-top: 1px solid var(--hairline-strong);
    border-bottom: 1px solid var(--hairline);
  }

  summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-4) 0;
    cursor: pointer;
    list-style: none;
    border-radius: var(--radius-sm);
  }

  summary::-webkit-details-marker {
    display: none;
  }

  .sum-main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .sum-main :global(.chev) {
    color: var(--text-3);
    transform: rotate(-90deg);
    transition: transform var(--t-2) var(--ease-out);
  }

  .crates[open] .sum-main :global(.chev) {
    transform: none;
  }

  .sum-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--text-lg);
    letter-spacing: var(--tracking-heading);
    color: var(--text);
  }

  summary:hover .sum-title {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .sum-count {
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 1px 8px;
    border-radius: var(--radius-pill);
    background: var(--selected);
    box-shadow: inset 0 0 0 1px var(--selected-ring);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .sum-licenses {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 0;
    padding-left: 24px;
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .sep {
    margin-inline: 0.5em;
  }

  .crate-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: var(--space-6);
    list-style: none;
    margin: 0;
    padding: 0 0 var(--space-4);
  }

  .crate {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: 'name ver' 'lic lic';
    gap: 0 var(--space-2);
    padding: 7px 0;
    border-top: 1px solid var(--hairline);
    font-size: var(--text-sm);
    min-width: 0;
  }

  .crate-name {
    grid-area: name;
    color: var(--text);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .crate-name:hover {
    color: var(--accent-strong);
    text-decoration: underline;
  }

  .crate-ver {
    grid-area: ver;
    font-size: var(--text-xs);
    color: var(--text-3);
  }

  .crate-lic {
    grid-area: lic;
    font-size: var(--text-xs);
  }

  .footnote {
    font-size: var(--text-sm);
    color: var(--text-3);
    max-width: 80ch;
  }

  @media (max-width: 1020px) {
    .group {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
    }

    .crate-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 759px) {
    .comps,
    .crate-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
