<!-- Renders sheets opened with openSheet(). -->
<script lang="ts">
  import Sheet from '../../components/Sheet.svelte';
  import { sheetStack } from './sheets.svelte';
</script>

{#each sheetStack.items as s (s.id)}
  <Sheet
    open={s.open}
    title={s.options.title}
    side={s.options.side ?? 'right'}
    size={s.options.size}
    hideTitle={s.options.hideTitle}
    onclose={() => sheetStack.close(s.id)}
  >
    <s.component {...s.props} close={() => sheetStack.close(s.id)} />
  </Sheet>
{/each}
