// Browser launch: the cached Playwright builds (chromium-1248 = Chromium 156, firefox-1555 = Firefox 157)
// driven by playwright-core 1.64.0. Every non-loopback destination goes to the leak sentinel, so the only way
// a page can reach the internet is through Wisp.
import { chromium, firefox } from 'playwright-core';
import { PORTS } from './config.mjs';

const sentinel = `127.0.0.1:${PORTS.sentinel}`;

export const BROWSERS = ['chromium', 'firefox'];

export async function launch(name, { extraPrefs = {}, sentinelProxy = true, extraArgs = [] } = {}) {
  if (name === 'chromium') {
    const args = [...extraArgs]; // extraArgs: optional Chromium switches (e.g. a replacement --disable-features list)
    // Loopback stays direct (Chromium's implicit bypass); everything else is sent to the sentinel.
    if (sentinelProxy) args.push(`--proxy-server=http://${sentinel}`);
    const opts = { headless: true, args };
    if (process.env.CHROMIUM_EXECUTABLE) opts.executablePath = process.env.CHROMIUM_EXECUTABLE;
    else if ((process.env.SPIKE_CHROMIUM_CHANNEL || 'chromium') === 'chromium') opts.channel = 'chromium'; // full chromium-1248, new headless
    return chromium.launch(opts);
  }
  if (name === 'firefox') {
    const prefs = {
      'devtools.jsonview.enabled': false, // show JSON as text so frames can be read uniformly
      ...extraPrefs,
    };
    if (sentinelProxy) {
      Object.assign(prefs, {
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': PORTS.sentinel,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': PORTS.sentinel,
        'network.proxy.no_proxies_on': '',
        'network.proxy.allow_hijacking_localhost': false, // loopback stays direct
      });
    }
    const opts = { headless: true, firefoxUserPrefs: prefs };
    if (process.env.FIREFOX_EXECUTABLE) opts.executablePath = process.env.FIREFOX_EXECUTABLE;
    return firefox.launch(opts);
  }
  throw new Error(`unknown browser ${name}`);
}

export async function newContext(browser) {
  return browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
}
