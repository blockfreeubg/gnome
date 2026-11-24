/**
 * VPN start-up (main.ts, on idle; docs/WAVE-C.md §3.2, §7.1, §8.1): the app page's VPN state, the tab-strip chip, the
 * browser's read-only facts (a lazy import of the browser module), this browser's exit check (pages/vpn,
 * only with `vpn.verifyExit` and a check service) and, last, `registerFeature('vpn')` in every build (D18, D20): the
 * Settings → VPN rows act through this module and the browser. Auto-connect is not here: the browser decides it in
 * its own start, before any tab loads (§8.1).
 */
import { registerFeature } from '../settings/features';
import { settings } from '../settings/store.svelte';
import { setBrowserFacts, vpnState, type BrowserFacts } from './state.svelte';
import { wireVpn } from './wire.svelte';

let started = false;

export function startVpn(): void {
  if (started) return;
  started = true;
  const state = vpnState();
  wireVpn(state);
  void Promise.all([import('../browser/browser.svelte'), import('../pages/vpn/browser-check.svelte')]).then(([{ browser }, { watchBrowserCheck }]) => {
    const facts: BrowserFacts = {
      get vpnLocation() {
        return browser.vpnLocation;
      },
      get engineState() {
        return browser.engineState;
      },
      get profileTransport() {
        return Object.values(browser.status?.transport ?? {})
          .filter((t) => t.endpoint === 'profile')
          .map((t) => ({ state: t.state, detail: t.detail }));
      },
    };
    setBrowserFacts(facts);
    watchBrowserCheck({
      get vpnLocation() {
        return browser.vpnLocation;
      },
      get engineState() {
        return browser.engineState;
      },
      get verifyExit() {
        return settings.value.vpn.verifyExit;
      },
      get verifyUrl() {
        return state.verifyUrl;
      },
      verify: (url) => browser.verifyExit(url),
    });
  });
  registerFeature('vpn');
}
