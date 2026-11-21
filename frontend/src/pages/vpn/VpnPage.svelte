<!-- VPN (egress gateways) — placeholder until the VPN page lands (Wave C): nobody can choose a location yet. -->
<script lang="ts">
  import Shield from '@lucide/svelte/icons/shield';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import PageHeader from '../../components/PageHeader.svelte';
  import type { PageProps } from '../../app/routes';
  import { server } from '../../app/server.svelte';
  import { settings } from '../../settings/store.svelte';

  let {}: PageProps = $props();

  // Say only what is true today: Settings → VPN is not built yet (its rows wait for the `vpn` feature, Wave C), so no
  // location can be chosen here or there. A location that arrived with imported or synced settings is still used:
  // the browser routes through it (snapshot.ts).
  const offered = $derived(server.config ? server.config.features.vpn_gateway : null);
  const on = $derived(settings.value.vpn.mode === 'gateway' && offered !== false);
  const title = $derived(offered === false ? 'This server offers no gateway' : on ? 'A gateway is selected' : 'No gateway in use');
  const description = $derived(
    offered === false
      ? 'Pages opened in GNOME go straight through this server. Its administrator can add VPN locations.'
      : on
        ? 'Pages opened in GNOME go through the VPN location saved in your settings. Choosing another one, the connection status and the exit check come with the VPN page in a later version of GNOME.'
        : 'This server offers VPN locations. Choosing one comes with the VPN page in a later version of GNOME; until then, pages opened in GNOME go straight through this server.',
  );
</script>

<div class="page narrow">
  <PageHeader title="VPN"
    description="Routes pages opened in GNOME through the selected gateway. Other apps on your device are not affected." />
  <div class="card">
    <EmptyState
      icon={Shield}
      {title}
      {description}
    >
      {#snippet actions()}
        <Button href="/settings/vpn" variant="outline" icon={Settings2}>VPN settings</Button>
      {/snippet}
    </EmptyState>
  </div>
</div>

<style>
  /* Placeholder until the feature lands: one glass card (DESIGN.md §9.4) holding an honest empty state. */
  .card {
    margin-top: var(--space-6);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  @media (max-width: 759px) {
    .card {
      margin-top: var(--space-4);
    }
  }
</style>
