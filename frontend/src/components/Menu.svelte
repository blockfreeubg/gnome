<!--
  Dropdown menu attached to a trigger. The trigger snippet receives props to spread on any button-like element:

  <Menu items={…} label="Tab actions">
    {#snippet trigger(props)}<IconButton {...props} icon={Ellipsis} label="More" />{/snippet}
  </Menu>

  ↓ / Enter / Space open and focus the first item, ↑ opens on the last item; focus returns to the trigger on close.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { createAttachmentKey } from 'svelte/attachments';
  import type { Placement } from './floating';
  import type { MenuCloseReason, MenuItem, MenuTriggerProps } from './menu';
  import MenuList from './MenuList.svelte';

  interface Props {
    items: readonly MenuItem[] | (() => readonly MenuItem[]);
    label: string;
    placement?: Placement;
    open?: boolean;
    trigger: Snippet<[MenuTriggerProps]>;
  }

  let { items, label, placement = 'bottom-start', open = $bindable(false), trigger }: Props = $props();

  const uid = $props.id();
  const menuId = `${uid}-menu`;
  let triggerEl = $state<HTMLElement>();
  let focusMode = $state<'first' | 'last' | 'menu'>('menu');
  const resolvedItems = $derived(typeof items === 'function' ? items() : items);

  function show(mode: 'first' | 'last' | 'menu'): void {
    focusMode = mode;
    open = true;
  }

  function close(reason: MenuCloseReason): void {
    open = false;
    if (reason !== 'outside') triggerEl?.focus();
  }

  const attachKey = createAttachmentKey();

  const triggerProps: MenuTriggerProps = {
    get 'aria-haspopup'() {
      return 'menu' as const;
    },
    get 'aria-expanded'() {
      return open;
    },
    get 'aria-controls'() {
      return open ? menuId : undefined;
    },
    onclick: (ev: MouseEvent) => {
      if (open) close('select');
      else show(ev.detail === 0 ? 'first' : 'menu');
    },
    onkeydown: (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        show('first');
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        show('last');
      }
    },
    [attachKey]: (node: HTMLElement) => {
      triggerEl = node;
    },
  };
</script>

{@render trigger(triggerProps)}

{#if open && triggerEl}
  <MenuList
    id={menuId}
    items={resolvedItems}
    {label}
    anchor={{ kind: 'element', element: triggerEl, placement }}
    autofocus={focusMode}
    onclose={close}
  />
{/if}
