<!--
  Select (WAI-ARIA "select-only combobox"): focus stays on the trigger while the listbox is open.
  Keys: ↓/↑/Enter/Space open · ↑↓ Home End PageUp PageDown move · Enter/Space choose · Esc closes · Tab closes ·
  typing jumps to matching options (also while closed, like a native select).
-->
<script lang="ts" generics="T extends string">
  import type { LucideIcon } from '@lucide/svelte';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { getFieldContext } from './field-context';
  import { autoPosition, topLayer, type Position } from './floating';
  import { createTypeahead, matchTypeahead } from './focus';
  import { popIn } from './motion';
  import Icon from './Icon.svelte';

  interface Option {
    value: T;
    label: string;
    description?: string;
    icon?: LucideIcon;
    disabled?: boolean;
  }

  interface Props {
    value: T;
    options: readonly Option[];
    label?: string;
    labelledby?: string;
    placeholder?: string;
    /** `lg` is the 44px card field, matching `<Input size="lg">` (DESIGN.md §10). */
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    full?: boolean;
    id?: string;
    onchange?: (value: T) => void;
    class?: string;
  }

  let {
    value = $bindable(),
    options,
    label,
    labelledby,
    placeholder = 'Select…',
    size = 'md',
    disabled = false,
    full = false,
    id,
    onchange,
    class: className = '',
  }: Props = $props();

  const field = getFieldContext();
  const uid = $props.id();
  const listId = `${uid}-listbox`;
  const optionId = (i: number): string => `${uid}-opt-${i}`;

  let open = $state(false);
  let active = $state(-1);
  let trigger = $state<HTMLButtonElement>();
  let maxHeight = $state(320);
  const typeahead = createTypeahead();

  const selectedIndex = $derived(options.findIndex((o) => o.value === value));
  const selected = $derived(options[selectedIndex]);
  const isDisabled = $derived(disabled || (field?.disabled ?? false));

  const enabled = (i: number): boolean => !!options[i] && !options[i]!.disabled;

  function move(from: number, dir: 1 | -1, count = 1): number {
    let i = from;
    let moved = 0;
    let last = from;
    while (moved < count) {
      i += dir;
      if (i < 0 || i >= options.length) break;
      if (enabled(i)) {
        last = i;
        moved++;
      }
    }
    return last;
  }

  function first(): number {
    return move(-1, 1);
  }
  function lastIndex(): number {
    return move(options.length, -1);
  }

  function show(at?: number): void {
    if (isDisabled || open) return;
    active = at ?? (selectedIndex >= 0 ? selectedIndex : first());
    open = true;
  }

  function hide(): void {
    open = false;
  }

  function choose(i: number): void {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    if (opt.value !== value) {
      value = opt.value;
      onchange?.(opt.value);
    }
    hide();
    trigger?.focus();
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (isDisabled) return;
    const k = ev.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        ev.preventDefault();
        show(k === 'ArrowUp' && selectedIndex < 0 ? lastIndex() : undefined);
        return;
      }
      if (k === 'Home' || k === 'End') {
        ev.preventDefault();
        show(k === 'Home' ? first() : lastIndex());
        return;
      }
      const q = !ev.ctrlKey && !ev.metaKey && !ev.altKey ? typeahead(k) : null;
      if (q) {
        const i = matchTypeahead(options.map((o) => o.label), q, selectedIndex, enabled);
        if (i >= 0 && options[i]!.value !== value) {
          value = options[i]!.value;
          onchange?.(value);
        }
      }
      return;
    }
    switch (k) {
      case 'ArrowDown':
        ev.preventDefault();
        active = ev.altKey ? active : move(active, 1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (ev.altKey) choose(active);
        else active = move(active, -1);
        break;
      case 'Home':
        ev.preventDefault();
        active = first();
        break;
      case 'End':
        ev.preventDefault();
        active = lastIndex();
        break;
      case 'PageDown':
        ev.preventDefault();
        active = move(active, 1, 10);
        break;
      case 'PageUp':
        ev.preventDefault();
        active = move(active, -1, 10);
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        choose(active);
        break;
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        hide();
        break;
      case 'Tab':
        hide();
        break;
      default: {
        const q = !ev.ctrlKey && !ev.metaKey && !ev.altKey ? typeahead(k) : null;
        if (q) {
          const i = matchTypeahead(options.map((o) => o.label), q, active, enabled);
          if (i >= 0) active = i;
        }
      }
    }
  }

  function popup(node: HTMLElement): () => void {
    const stop = autoPosition(trigger!, node, 'bottom-start', {
      offset: 4,
      matchWidth: true,
      onPosition: (p: Position) => (maxHeight = Math.max(120, Math.min(320, p.available))),
    });
    const onDown = (ev: PointerEvent): void => {
      const t = ev.target as Node;
      if (!node.contains(t) && !trigger?.contains(t)) hide();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      stop();
      document.removeEventListener('pointerdown', onDown, true);
    };
  }

  // Keep the active option visible.
  $effect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });
</script>

<button
  bind:this={trigger}
  type="button"
  role="combobox"
  id={id ?? field?.controlId}
  class="select {size} {className}"
  class:full
  class:open
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-controls={open ? listId : undefined}
  aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
  aria-label={labelledby || field ? undefined : label}
  aria-labelledby={labelledby ?? field?.labelId}
  aria-describedby={field?.describedBy}
  disabled={isDisabled}
  onclick={() => (open ? hide() : show())}
  onkeydown={onKeydown}
  onblur={() => hide()}
>
  {#if selected?.icon}<Icon icon={selected.icon} size={16} />{/if}
  <span class="value" class:placeholder={!selected}>{selected?.label ?? placeholder}</span>
  <span class="chevron" aria-hidden="true"><ChevronDown size={15} strokeWidth={1.75} /></span>
</button>

{#if open}
  <ul
    id={listId}
    class="listbox"
    role="listbox"
    tabindex="-1"
    aria-labelledby={labelledby ?? field?.labelId}
    aria-label={labelledby || field ? undefined : label}
    style:max-height="{maxHeight}px"
    onmousedown={(ev) => ev.preventDefault() /* keep focus on the trigger: options, padding, scrollbar (all browsers) */}
    {@attach topLayer}
    {@attach popup}
    transition:popIn={{ duration: 120, origin: 'top center' }}
  >
    {#each options as opt, i (opt.value)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id={optionId(i)}
        role="option"
        class="option"
        class:active={i === active}
        aria-selected={opt.value === value}
        aria-disabled={opt.disabled ? 'true' : undefined}
        onpointermove={() => {
          if (!opt.disabled) active = i;
        }}
        onclick={() => choose(i)}
      >
        {#if opt.icon}<Icon icon={opt.icon} size={16} />{/if}
        <span class="opt-text">
          <span class="opt-label">{opt.label}</span>
          {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
        </span>
        {#if opt.value === value}<span class="check"><Check size={15} strokeWidth={2} aria-hidden="true" /></span>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .select {
    --h: var(--control-h);
    --f-bg: var(--surface-1);
    --f-border: var(--hairline-strong);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 140px;
    max-width: 100%;
    height: var(--h);
    padding: 0 9px 0 var(--control-px);
    border: 1px solid var(--f-border);
    border-radius: var(--radius);
    background: var(--f-bg);
    color: var(--text);
    font-weight: 500;
    text-align: left;
    transition:
      border-color var(--t-1) var(--ease-out),
      background-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out);
  }

  /* Wells: inside cards and dialogs the trigger sits a step below the surface, like the text fields. */
  :global(:is(dialog, .glass-card, [data-field-well])) .select {
    --f-bg: var(--field-bg);
    --f-border: var(--field-border);
  }

  .select:hover:not(:disabled) {
    border-color: var(--field-border-hover);
  }

  .select:hover:not(:disabled) .chevron {
    color: var(--text-2);
  }

  .select:focus-visible,
  .select.open {
    outline: none;
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
  }

  .sm {
    --h: var(--control-h-sm);
    padding: 0 6px 0 calc(var(--control-px) - 3px);
    border-radius: calc(var(--radius) - 2px);
    font-size: var(--text-sm);
  }

  /* The card field (ivy), as Input's lg: 44px+, a softer 13px corner, 15px text. */
  .lg {
    --h: max(var(--control-h-lg), calc(3.2857rem * var(--density)));
    padding: 0 10px 0 calc(var(--control-px) + 2px);
    border-radius: calc(var(--radius) + 3px);
    font-size: 1.0714rem;
  }

  .full {
    width: 100%;
  }

  .value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .placeholder {
    color: var(--text-3);
    font-weight: 400;
  }

  .chevron {
    display: grid;
    color: var(--text-3);
    transition:
      transform var(--t-2) var(--ease-out),
      color var(--t-1) var(--ease-out);
  }

  .open .chevron {
    transform: rotate(180deg);
    color: var(--text-2);
  }

  .select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* The listbox is a menu surface (DESIGN.md §10 Menu). */
  .listbox {
    position: fixed;
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: var(--radius-lg);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--shadow-pop);
    outline: none;
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--item-h);
    padding: 4px 10px;
    border-radius: calc(var(--radius) - 2px);
    font-size: 0.9286rem;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }

  .option.active {
    background: var(--hover);
  }

  .option[aria-selected='true'] .opt-label {
    font-weight: 600;
  }

  .option[aria-disabled='true'] {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .opt-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .opt-desc {
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .check {
    display: grid;
    color: var(--accent);
  }

  @media (forced-colors: active) {
    .option.active {
      outline: 1px solid Highlight;
    }
  }
</style>
