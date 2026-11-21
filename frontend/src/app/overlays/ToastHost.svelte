<!--
  Hosts the toast stack (ToastStack.svelte) in a layer of its own that stays above everything: shown in the browser's
  top layer (a manual popover) and, while a modal dialog is open, moved into the topmost one. Outside it the toasts
  would be drawn under the dialog's backdrop, or above it but inert (a modal makes the rest of the page inert), so an
  error raised by a dialog could be neither read nor dismissed. Without the Popover API the layer stays in <body>
  with a high z-index.
-->
<script lang="ts">
  import { mount, unmount } from 'svelte';
  import { topModal } from '../../components/modal-stack.svelte';
  import { supportsPopover } from '../../lib/platform';
  import ToastStack from './ToastStack.svelte';
  import { toast } from './toast.svelte';

  const popover = supportsPopover();
  let layer = $state<HTMLElement | null>(null);

  // The layer is created here rather than rendered as markup: it is moved between <body> and dialogs, which must
  // never happen to nodes a component owns.
  $effect(() => {
    const el = document.createElement('div');
    el.className = 'toast-layer';
    if (popover) el.setAttribute('popover', 'manual');
    document.body.append(el);
    const app = mount(ToastStack, { target: el });
    layer = el;
    return () => {
      layer = null;
      void unmount(app);
      el.remove();
    };
  });

  $effect(() => {
    const el = layer;
    if (!el || !popover) return;
    const visible = toast.items.length > 0;
    const host = topModal() ?? document.body;
    let shown = el.matches(':popover-open');
    // Follow the topmost modal (and leave a closed one) even while empty, so the layer is never left inside a dialog
    // that may be torn down. Showing again after a move puts it at the top of the top layer.
    if (el.parentElement !== host) {
      if (shown) el.hidePopover();
      shown = false;
      host.append(el);
    }
    if (visible && !shown) el.showPopover();
    else if (!visible && shown) el.hidePopover();
  });
</script>
