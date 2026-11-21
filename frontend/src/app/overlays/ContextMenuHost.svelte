<!-- Renders the app-wide context menu opened with openContextMenu(). -->
<script lang="ts">
  import MenuList from '../../components/MenuList.svelte';
  import { closeContextMenu, contextMenuState } from './contextmenu.svelte';
</script>

{#if contextMenuState.open && contextMenuState.anchor}
  {#key contextMenuState.key}
    <MenuList
      items={contextMenuState.items}
      anchor={contextMenuState.anchor}
      label={contextMenuState.label}
      autofocus={contextMenuState.autofocus}
      onclose={(reason) => closeContextMenu(reason)}
    />
  {/key}
{/if}
