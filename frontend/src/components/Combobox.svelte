<!--
  Editable combobox (input + listbox popup, aria-activedescendant). The caller filters `options` from `value`.
  Keys: ↓ opens / moves · ↑ moves (back to the text at the top) · Enter picks the active option or submits the text ·
  Esc closes (a second Esc is left to the caller) · Tab closes. Options can be grouped and custom-rendered.
-->
<script lang="ts" module>
  export interface ComboboxModifiers {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }
</script>

<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import type { LucideIcon } from '@lucide/svelte';
  import { autoPosition, topLayer, type Position } from './floating';
  import { getFieldContext } from './field-context';
  import { popIn } from './motion';
  import Icon from './Icon.svelte';
  import Spinner from './Spinner.svelte';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'size' | 'class' | 'onselect' | 'onsubmit' | 'children'> {
    value: string;
    options: readonly T[];
    getKey: (option: T) => string;
    getLabel: (option: T) => string;
    getGroup?: (option: T) => string | undefined;
    isDisabled?: (option: T) => boolean;
    /** Custom option content. */
    option?: Snippet<[T, { active: boolean; index: number }]>;
    /** Content shown when open with no options (e.g. "No matches"). */
    empty?: Snippet;
    footer?: Snippet;
    onselect: (option: T, mods: ComboboxModifiers) => void;
    /** Enter with no active option. */
    onsubmit?: (text: string, mods: ComboboxModifiers) => void;
    open?: boolean;
    /** Highlight the first option automatically (omnibox style: Enter takes the top suggestion). */
    autoActivateFirst?: boolean;
    label?: string;
    icon?: LucideIcon;
    size?: 'md' | 'lg' | 'xl';
    loading?: boolean;
    trailing?: Snippet;
    element?: HTMLInputElement;
    placement?: 'bottom-start' | 'top-start';
    class?: string;
  }

  let {
    value = $bindable(''),
    options,
    getKey,
    getLabel,
    getGroup,
    isDisabled = () => false,
    option,
    empty,
    footer,
    onselect,
    onsubmit,
    open = $bindable(false),
    autoActivateFirst = false,
    label,
    icon,
    size = 'md',
    loading = false,
    trailing,
    element = $bindable(),
    placement = 'bottom-start',
    class: className = '',
    id,
    onkeydown,
    onfocus,
    oninput,
    ...rest
  }: Props = $props();

  const field = getFieldContext();
  const uid = $props.id();
  const listId = `${uid}-listbox`;
  const optionId = (i: number): string => `${uid}-opt-${i}`;

  /** Active option; resets (first option or none) whenever the option list changes. */
  let active = $derived(autoActivateFirst && options.length > 0 && !isDisabled(options[0]!) ? 0 : -1);
  let wrap = $state<HTMLDivElement>();
  let maxHeight = $state(420);

  const hasContent = $derived(options.length > 0 || !!empty);
  const showPopup = $derived(open && hasContent);

  // Groups (consecutive options sharing a group label).
  const groups = $derived.by(() => {
    const out: Array<{ label: string | undefined; items: Array<{ option: T; index: number }> }> = [];
    options.forEach((o, index) => {
      const g = getGroup?.(o);
      const last = out[out.length - 1];
      if (last && last.label === g) last.items.push({ option: o, index });
      else out.push({ label: g, items: [{ option: o, index }] });
    });
    return out;
  });

  function mods(ev: KeyboardEvent | MouseEvent): ComboboxModifiers {
    return { altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey };
  }

  function step(dir: 1 | -1): void {
    const n = options.length;
    if (n === 0) return;
    let i = active;
    for (let k = 0; k < n + 1; k++) {
      i += dir;
      if (i < -1) i = n - 1;
      if (i >= n) i = -1;
      if (i === -1 || !isDisabled(options[i]!)) break;
    }
    active = i;
  }

  function pick(i: number, m: ComboboxModifiers): void {
    const o = options[i];
    if (o === undefined || isDisabled(o)) return;
    open = false;
    onselect(o, m);
  }

  function handleKeydown(ev: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }): void {
    if (ev.isComposing) return;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        if (!open) open = true;
        else step(1);
        break;
      case 'ArrowUp':
        if (open) {
          ev.preventDefault();
          step(-1);
        }
        break;
      case 'Enter':
        ev.preventDefault();
        if (open && active >= 0) pick(active, mods(ev));
        else {
          open = false;
          onsubmit?.(value, mods(ev));
        }
        break;
      case 'Escape':
        if (open && hasContent) {
          ev.preventDefault();
          ev.stopPropagation();
          open = false;
          return;
        }
        break;
      case 'Tab':
        open = false;
        break;
    }
    onkeydown?.(ev);
  }

  function popup(node: HTMLElement): () => void {
    const stop = autoPosition(wrap!, node, placement, {
      offset: 6,
      matchWidth: true,
      onPosition: (p: Position) => (maxHeight = Math.max(160, Math.min(460, p.available))),
    });
    const onDown = (ev: PointerEvent): void => {
      const t = ev.target as Node;
      if (!node.contains(t) && !wrap?.contains(t)) open = false;
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      stop();
      document.removeEventListener('pointerdown', onDown, true);
    };
  }

  $effect(() => {
    if (!showPopup || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div bind:this={wrap} class="combobox {size} {className}" class:open={showPopup}>
  {#if icon}<span class="lead"><Icon {icon} size={size === 'md' ? 16 : 20} /></span>{/if}
  <input
    {...rest}
    bind:this={element}
    bind:value
    id={id ?? field?.controlId}
    type="text"
    role="combobox"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    aria-autocomplete="list"
    aria-expanded={showPopup}
    aria-controls={showPopup ? listId : undefined}
    aria-activedescendant={showPopup && active >= 0 ? optionId(active) : undefined}
    aria-label={field ? undefined : (rest['aria-label'] ?? label)}
    aria-describedby={field?.describedBy}
    onkeydown={handleKeydown}
    oninput={(ev) => {
      open = true;
      oninput?.(ev);
    }}
    onfocus={(ev) => {
      onfocus?.(ev);
    }}
  />
  {#if loading}<span class="trail"><Spinner size={14} /></span>{/if}
  {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
</div>

{#if showPopup}
  <div
    class="popup"
    style:max-height="{maxHeight}px"
    {@attach topLayer}
    {@attach popup}
    transition:popIn={{ duration: 120, scale: 0.985, origin: 'top center' }}
  >
    <!-- mousedown (not pointerdown): Firefox still moves focus after a canceled pointerdown. Keeps focus in the input
         when options, group labels, padding or the scrollbar are pressed. -->
    <ul id={listId} role="listbox" aria-label={label ?? 'Suggestions'} class="listbox" onmousedown={(ev) => ev.preventDefault()}>
      {#each groups as group, gi (gi)}
        {#if group.label}
          <li role="presentation" class="group-label eyebrow" id="{uid}-g{gi}">{group.label}</li>
        {/if}
        {#each group.items as item (getKey(item.option))}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(item.index)}
            role="option"
            class="option"
            class:active={item.index === active}
            aria-selected={item.index === active}
            aria-disabled={isDisabled(item.option) ? 'true' : undefined}
            aria-describedby={group.label ? `${uid}-g${gi}` : undefined}
            onpointermove={() => {
              if (!isDisabled(item.option)) active = item.index;
            }}
            onclick={(ev) => pick(item.index, mods(ev))}
          >
            {#if option}
              {@render option(item.option, { active: item.index === active, index: item.index })}
            {:else}
              <span class="default-label">{getLabel(item.option)}</span>
            {/if}
          </li>
        {/each}
      {/each}
    </ul>
    {#if options.length === 0 && empty}
      <div class="empty">{@render empty()}</div>
    {/if}
    {#if footer}<div class="footer">{@render footer()}</div>{/if}
  </div>
{/if}

<style>
  .combobox {
    --h: var(--control-h);
    --f-bg: var(--surface-1);
    --f-border: var(--hairline-strong);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--h);
    padding: 0 var(--control-px);
    border: 1px solid var(--f-border);
    border-radius: var(--radius);
    background: var(--f-bg);
    color: var(--text);
    transition:
      border-color var(--t-1) var(--ease-out),
      box-shadow var(--t-2) var(--ease-out),
      background-color var(--t-1) var(--ease-out);
  }

  /* Wells: inside cards and dialogs the field sits a step below the surface (ivy). */
  :global(:is(dialog, .glass-card, [data-field-well])) .combobox {
    --f-bg: var(--field-bg);
    --f-border: var(--field-border);
  }

  .combobox:hover {
    border-color: var(--field-border-hover);
  }

  .combobox:focus-within {
    border-color: var(--focus-border);
    box-shadow: 0 0 0 3px var(--focus-halo);
  }

  .lg {
    --h: max(var(--control-h-lg), calc(3.2857rem * var(--density)));
    gap: 10px;
    padding: 0 calc(var(--control-px) + 2px);
    border-radius: calc(var(--radius) + 3px);
    font-size: 1.0714rem;
  }

  /* The hero search (Home / new tab): a 48px translucent pill. */
  .xl {
    --h: calc(3.4286rem * var(--density));
    --f-bg: color-mix(in oklab, var(--bg) 62%, transparent);
    padding: 0 18px;
    gap: 12px;
    font-size: var(--text-lg);
    border-radius: var(--radius-pill);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
  }

  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: transparent;
    outline: none;
    color: inherit;
  }

  input::placeholder {
    color: var(--text-3);
    opacity: 1;
  }

  .lead,
  .trail {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-3);
  }

  /* Never wider than the window: long titles and URLs truncate inside the options instead of pushing the list off
     the right edge of a phone. */
  .popup {
    position: fixed;
    max-width: calc(100vw - 16px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--radius-lg);
    background: var(--glass-bg-dense);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
    border: 1px solid var(--glass-border);
    box-shadow: var(--shadow-pop);
  }

  .listbox {
    flex: 1;
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .group-label {
    padding: 10px 10px 4px;
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: max(var(--item-h), calc(2.4rem * var(--density)));
    padding: 6px 10px;
    border-radius: calc(var(--radius) - 2px);
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }

  /* --hover, not --selected: option snippets may carry --text-3 details, which need ≥ 4.5:1 on the active row. */
  .option.active {
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }

  .option[aria-disabled='true'] {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .empty {
    padding: 14px;
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  .footer {
    border-top: 1px solid var(--hairline);
    padding: 8px 12px;
    font-size: var(--text-xs);
    color: var(--text-2);
  }

  @media (forced-colors: active) {
    .option.active {
      outline: 1px solid Highlight;
    }
  }
</style>
