<!--
  Editor for one shortcut: shows the binding, records a new combo (Esc cancels), and resolves conflicts with other
  actions (replace or cancel). Warns about combos browsers keep for themselves and combos that edit text.
-->
<script lang="ts">
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import X from '@lucide/svelte/icons/x';
  import Button from '../../components/Button.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Kbd from '../../components/Kbd.svelte';
  import { conflictsFor, isReservedCombo, recordCombo, SHORTCUT_LABELS } from '../../app/shortcuts';
  import { describeCombo, isTextEditingCombo } from '../../lib/keys';
  import { isApplePlatform } from '../../lib/platform';
  import type { ShortcutAction } from '../../settings/schema';
  import { settings } from '../../settings/store.svelte';

  interface Props {
    action: ShortcutAction;
  }

  let { action }: Props = $props();

  const combo = $derived(settings.value.browser.shortcuts[action]);
  const apple = isApplePlatform();
  let recording = $state(false);
  let pending = $state<{ combo: string; conflicts: ShortcutAction[] } | null>(null);

  const conflicts = $derived(combo ? conflictsFor(combo, action) : []);
  const reserved = $derived(!!combo && isReservedCombo(combo));
  const editing = $derived(!!combo && isTextEditingCombo(combo, apple));

  function bind(next: string, unbind: readonly ShortcutAction[] = []): void {
    const map = { ...settings.value.browser.shortcuts, [action]: next };
    for (const other of unbind) map[other] = '';
    settings.set('browser', 'shortcuts', map);
  }

  function start(): void {
    pending = null;
    recording = true;
  }

  function stop(): void {
    recording = false;
  }

  $effect(() => {
    if (!recording) return;
    const onKey = (ev: KeyboardEvent): void => {
      // Capture phase on window: the global shortcut dispatcher never sees the keys being recorded.
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
        stop();
        return;
      }
      if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        stop();
        return;
      }
      const next = recordCombo(ev);
      if (!next) return; // a lone modifier: keep listening
      stop();
      const others = conflictsFor(next, action);
      if (others.length) pending = { combo: next, conflicts: others };
      else bind(next);
    };
    const onBlur = (): void => stop();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  });

  const names = (list: readonly ShortcutAction[]): string => list.map((a) => `“${SHORTCUT_LABELS[a]}”`).join(', ');
</script>

<div class="editor">
  <div class="line">
    {#if recording}
      <span class="recording" role="status">Press the new keys… <span class="subtle">Esc cancels</span></span>
    {:else if combo}
      <Kbd {combo} />
    {:else}
      <span class="unset">Not set</span>
    {/if}
    <Button size="sm" variant={recording ? 'secondary' : 'ghost'} icon={Keyboard} onclick={recording ? stop : start} aria-pressed={recording}>
      {recording ? 'Cancel' : combo ? 'Change' : 'Set'}
    </Button>
    {#if combo && !recording}
      <IconButton icon={X} size="sm" label="Remove the shortcut for {SHORTCUT_LABELS[action]}" onclick={() => bind('')} />
    {/if}
  </div>
  {#if pending}
    <div class="notice warn" role="alert">
      <span><Kbd combo={pending.combo} size="sm" /> is used by {names(pending.conflicts)}.</span>
      <span class="actions">
        <Button size="sm" variant="primary" onclick={() => (bind(pending!.combo, pending!.conflicts), (pending = null))}>Use it here</Button>
        <Button size="sm" variant="ghost" onclick={() => (pending = null)}>Keep the old one</Button>
      </span>
    </div>
  {:else if conflicts.length}
    <p class="notice warn">Also bound to {names(conflicts)}; only one of them will run.</p>
  {:else if reserved}
    <p class="notice">
      Your browser keeps {describeCombo(combo, apple)} for itself. It works only while GNOME is in fullscreen or installed as an app.
    </p>
  {:else if editing}
    <p class="notice">This combo also edits text, so it does nothing while you type in a field.</p>
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--control-h);
  }

  .recording {
    font-size: var(--text-sm);
    color: var(--accent);
  }

  .unset {
    font-size: var(--text-sm);
    color: var(--text-3);
  }

  .notice {
    font-size: var(--text-sm);
    color: var(--text-2);
    max-width: 44ch;
    text-align: right;
  }

  .notice.warn {
    color: var(--warning);
  }

  div.notice {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
  }

  @media (max-width: 640px) {
    .editor,
    div.notice {
      align-items: flex-start;
    }

    .notice {
      text-align: left;
    }
  }
</style>
