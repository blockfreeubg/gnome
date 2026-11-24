/** The VPN state's dependencies in the app: the settings store, `/api/config`, the API and the toast queue. */
import { toast } from '../app/overlays/toast.svelte';
import { server } from '../app/server.svelte';
import { settings } from '../settings/store.svelte';
import { checkLocationResult, fetchLocations } from './api';
import type { VpnDeps } from './state.svelte';

export function appVpnDeps(): VpnDeps {
  return {
    fetchLocations,
    checkLocation: checkLocationResult,
    vpn: () => settings.value.vpn,
    setVpn: (key, value) => void settings.set('vpn', key, value),
    onVpnChange: (fn) =>
      settings.onChange((c) => {
        if (c.sections.includes('vpn')) fn();
      }),
    offered: () => server.config?.wisp.profiles ?? null,
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    toast: (message) => toast.info(message),
  };
}
