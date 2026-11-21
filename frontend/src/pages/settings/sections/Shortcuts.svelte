<script lang="ts">
  import Kbd from '../../../components/Kbd.svelte';
  import { isApplePlatform } from '../../../lib/platform';
  import { RESERVED_COMBOS } from '../../../settings/defaults';
  import { isFeatureActive } from '../../../settings/features';
  import type { ShortcutAction } from '../../../settings/schema';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';
  import ShortcutEditor from '../ShortcutEditor.svelte';

  const S = 'shortcuts' as const;
  const apple = isApplePlatform();
  /** Reserved combos for this platform (⌘ on Apple, Ctrl/Alt elsewhere). */
  const reserved = RESERVED_COMBOS.filter((c) => (apple ? c.startsWith('Meta+') : !c.startsWith('Meta+')));

  const GROUPS: ReadonlyArray<{ title: string; actions: ShortcutAction[] }> = [
    { title: 'Tabs', actions: ['newTab', 'closeTab', 'reopenClosedTab', 'nextTab', 'prevTab', 'duplicateTab', 'pinTab'] },
    { title: 'Navigation', actions: ['focusOmnibox', 'back', 'forward', 'reload', 'hardReload', 'home', 'findInPage'] },
    { title: 'View', actions: ['zoomIn', 'zoomOut', 'zoomReset', 'toggleFullscreen', 'toggleSidebar'] },
    {
      title: 'Pages',
      actions: ['commandPalette', 'bookmarkPage', 'openHistory', 'openBookmarks', 'openDownloads', 'openGames', 'openSettings'],
    },
    {
      title: 'Go to tab',
      actions: ['selectTab1', 'selectTab2', 'selectTab3', 'selectTab4', 'selectTab5', 'selectTab6', 'selectTab7', 'selectTab8', 'selectTab9'],
    },
  ];
</script>

<Group keep>
  {#snippet note()}
    <p>
      Shortcuts work anywhere in GNOME{isFeatureActive('browser') ? ', including inside pages you browse' : ''}. Your
      browser keeps some combinations for itself, so GNOME’s defaults use {apple ? '⌥ Option' : 'Alt'}. These never
      reach a web page in a normal window:
    </p>
    <p class="reserved">
      {#each reserved as c (c)}<Kbd combo={c} size="sm" />{/each}
    </p>
  {/snippet}
</Group>

{#each GROUPS as g (g.title)}
  <Group title={g.title}>
    {#each g.actions as action (action)}
      <Row section={S} id={action}>
        {#snippet control()}
          <ShortcutEditor {action} />
        {/snippet}
      </Row>
    {/each}
  </Group>
{/each}

<style>
  .reserved {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    margin-top: var(--space-3);
  }
</style>
