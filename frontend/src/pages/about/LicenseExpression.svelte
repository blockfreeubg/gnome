<!--
  A license expression with each license linked to its text ("MIT or Apache License 2.0"). Anything that is not an
  expression of known ids (free text from a server, e.g. "No explicit licence; …") is shown as written.
-->
<script lang="ts">
  import { isLicenseExpression, licenseParts } from './licenses';

  interface Props {
    expression: string;
    /** Short ids ("MIT", "Apache-2.0") instead of full names; the full name stays in the tooltip. */
    short?: boolean;
  }

  let { expression, short = false }: Props = $props();

  const parts = $derived(licenseParts(expression));
  const structured = $derived(isLicenseExpression(expression));
</script>

{#if !structured}
  <span class="free">{expression}</span>
{:else}
  <span class="expr">
    {#each parts as part, i (i)}
      {#if part.kind === 'license'}
        <a class="lic" href={part.url} target="_blank" rel="external noopener noreferrer" title={part.name}>
          {short && !part.key.startsWith('LicenseRef-') ? part.key : part.name}
        </a>
      {:else}
        <span class={part.text === '(' || part.text === ')' ? 'paren' : 'op'}>{part.text}</span>
      {/if}
    {/each}
  </span>
{/if}

<style>
  .expr {
    display: inline;
  }

  .lic {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.18em;
    text-decoration-color: color-mix(in oklab, var(--accent) 35%, transparent);
    white-space: nowrap;
  }

  .lic:hover {
    color: var(--accent-strong);
    text-decoration-color: currentColor;
  }

  .op {
    color: var(--text-3);
    margin-inline: 0.3em;
  }

  .paren {
    color: var(--text-3);
  }

  .free {
    color: var(--text-2);
  }
</style>
