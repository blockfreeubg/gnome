<!--
  The toast stack (bottom right; bottom center on narrow screens, above the mobile bar). Mounted by ToastHost into
  its own layer element, which follows modal dialogs into the top layer.
-->
<script lang="ts">
  import { flip } from 'svelte/animate';
  import Toast from '../../components/Toast.svelte';
  import { dur, fadeRise } from '../../components/motion';
  import { toast } from './toast.svelte';
</script>

<section class="toasts" aria-label="Notifications" tabindex="-1">
  {#each toast.items as item (item.id)}
    <div class="slot" animate:flip={{ duration: dur(200) }} transition:fadeRise={{ duration: 220, y: 10 }}>
      {#key item.version}
        <Toast
          title={item.title}
          description={item.description}
          kind={item.kind}
          actions={item.actions}
          duration={item.duration}
          ondismiss={() => toast.dismiss(item.id)}
        />
      {/key}
    </div>
  {/each}
</section>

<style>
  /* The layer ToastHost creates (a manual popover where supported): reset the UA popover box. */
  :global(.toast-layer) {
    position: fixed;
    inset: auto 16px calc(16px + var(--safe-bottom)) auto;
    width: auto;
    height: auto;
    max-width: calc(100vw - 32px);
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    overflow: visible;
    z-index: var(--z-toast);
    pointer-events: none;
  }

  .toasts {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    pointer-events: none;
    outline: none;
  }

  .toasts:empty {
    display: none;
  }

  @media (max-width: 759px) {
    :global(.toast-layer) {
      left: 12px;
      right: 12px;
      bottom: calc(var(--bottom-bar-h) + 12px + var(--safe-bottom));
      max-width: none;
    }

    .toasts {
      align-items: center;
    }
  }
</style>
