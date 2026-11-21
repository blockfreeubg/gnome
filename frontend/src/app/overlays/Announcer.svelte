<!-- Persistent live regions for screen-reader announcements (see announcer.svelte.ts). -->
<script lang="ts">
  import { announcerState } from '../announcer.svelte';
</script>

<div class="sr-only" aria-live="polite" aria-atomic="true">{announcerState.polite}</div>
<div class="sr-only" aria-live="assertive" aria-atomic="true">{announcerState.assertive}</div>
