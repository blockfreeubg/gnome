<!-- 1px hairline. With `label` it renders an inline caption between two hairlines. -->
<script lang="ts">
  interface Props {
    orientation?: 'horizontal' | 'vertical';
    label?: string;
    strong?: boolean;
    /** Vertical spacing around a horizontal divider (CSS length). */
    spacing?: string;
    class?: string;
  }

  let { orientation = 'horizontal', label, strong = false, spacing = '0', class: className = '' }: Props = $props();
</script>

{#if label && orientation === 'horizontal'}
  <div class="labelled {className}" class:strong role="separator" aria-label={label} style:margin-block={spacing}>
    <span class="eyebrow" aria-hidden="true">{label}</span>
  </div>
{:else}
  <div
    class="divider {orientation} {className}"
    class:strong
    role="separator"
    aria-orientation={orientation}
    style:margin-block={orientation === 'horizontal' ? spacing : undefined}
  ></div>
{/if}

<style>
  .divider.horizontal {
    height: 1px;
    width: 100%;
    background: var(--hairline);
  }

  .divider.vertical {
    width: 1px;
    align-self: stretch;
    background: var(--hairline);
  }

  .strong.divider {
    background: var(--hairline-strong);
  }

  /* ivy "or" divider: a small bold caption between two hairlines. */
  .labelled {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .labelled .eyebrow {
    font-size: var(--text-sm);
    letter-spacing: 0.02em;
    text-transform: none;
  }

  .labelled::before,
  .labelled::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--hairline);
  }

  .strong.labelled::before,
  .strong.labelled::after {
    background: var(--hairline-strong);
  }
</style>
