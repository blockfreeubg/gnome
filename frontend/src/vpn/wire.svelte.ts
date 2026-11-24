/**
 * The VPN state's reactive wiring for the app page (start.ts): the tab-strip chip follows the connection
 * (`reportStatus('vpn')` / `clearStatus('vpn')`, §7.1), and the poller is kicked when `/api/config` changes and when
 * the page becomes visible again.
 */
import { server } from '../app/server.svelte';
import { clearStatus, reportStatus } from '../app/status';
import { chipStatus, type VpnStateImpl } from './state.svelte';

export function wireVpn(state: VpnStateImpl): () => void {
  const stopRoot = $effect.root(() => {
    $effect(() => {
      const chip = chipStatus(state.connection);
      if (chip) reportStatus('vpn', chip);
      else clearStatus('vpn');
    });
    $effect(() => {
      void server.config?.wisp.profiles;
      state.kick();
    });
  });
  const onVisible = () => {
    if (document.visibilityState === 'visible') state.kick();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopRoot();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
