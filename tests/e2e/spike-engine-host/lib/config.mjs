// Shared configuration of the two-origin engine-host spike (docs/research/spike-engine-host.md).
// Every port lives in the proxy lane's range 22000-22999; each can be overridden from the environment.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPIKE_DIR = path.resolve(here, '..');
export const E2E_DIR = path.resolve(SPIKE_DIR, '..');
export const REPO_DIR = path.resolve(E2E_DIR, '..', '..');
export const NODE_MODULES = path.join(E2E_DIR, 'node_modules');

const port = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${name} must be a port number, got ${v}`);
  return n;
};

export const PORTS = {
  app: port('SPIKE_APP_PORT', 22080), // app origin (shell + API stub)
  proxy: port('SPIKE_PROXY_PORT', 22081), // proxy origin (engine host, SW, vendor, /wisp/ gateway stub)
  target: port('SPIKE_TARGET_PORT', 22090), // local "remote site", reachable only through the TEST-ONLY HolyWisp
  sentinel: port('SPIKE_SENTINEL_PORT', 22099), // leak sentinel: the browsers' only route to non-loopback hosts
  hwProd: port('SPIKE_HOLYWISP_PORT', 22060), // HolyWisp with services/holywisp/gnome.conf (port changed only)
  hwTest: port('SPIKE_HOLYWISP_TEST_PORT', 22061), // HolyWisp with gnome.conf + holywisp-test-only.conf
};

// Host names. 127.0.0.1 with two ports = same-site, cross-origin, both potentially trustworthy (secure contexts).
export const HOST = '127.0.0.1';
export const APP_ORIGIN = `http://${HOST}:${PORTS.app}`;
export const PROXY_ORIGIN = `http://${HOST}:${PORTS.proxy}`;
// Cross-site variant of the app origin ("localhost" is a different site than 127.0.0.1); used by the
// optional cross-site check in the sw suite.
export const APP_ORIGIN_XSITE = `http://localhost:${PORTS.app}`;
export const TARGET_ORIGIN = `http://${HOST}:${PORTS.target}`;
export const TARGET_ORIGIN_ALT = `http://localhost:${PORTS.target}`; // second "site" served by the same target server

// The Wisp ticket the gateway stub accepts (a fixed test string in the shape of ARCHITECTURE §4.6 tickets).
export const TICKETS = {
  first: 'w1.4102444800.spike0session0ref.dGVzdC10aWNrZXQtMQ',
  rotated: 'w1.4102444800.spike0session0ref.dGVzdC10aWNrZXQtMg',
};

// Wisp routes of the gateway stub. /wisp/ mirrors the production route; /wisp/p/test-loopback/ mirrors a
// VPN-profile route (§4.4) and leads to the TEST-ONLY HolyWisp that may reach 127.0.0.1 (the target server).
export const WISP_ROUTES = {
  '/wisp/': 'hwProd',
  '/wisp/p/test-loopback/': 'hwTest',
};

export const HOLYWISP = {
  // Binary built by services/holywisp/fetch-build.sh (static-pie musl), run inside a locked-down container.
  bin: process.env.HOLYWISP_BIN || path.join(REPO_DIR, 'services', 'holywisp', 'build', os.arch() === 'arm64' ? 'aarch64' : 'x86_64', 'holywisp'),
  // Packaged image (services/holywisp/Dockerfile). When set, used instead of HOLYWISP_BIN.
  image: process.env.HOLYWISP_IMAGE || '',
  // docker (default; third-party code runs in a container) or host (only for CI machines without Docker).
  runner: process.env.HOLYWISP_RUNNER || 'docker',
  conf: path.join(REPO_DIR, 'services', 'holywisp', 'gnome.conf'),
  testOnlyConf: path.join(SPIKE_DIR, 'holywisp-test-only.conf'),
  dockerfile: path.join(REPO_DIR, 'services', 'holywisp', 'Dockerfile'),
};

export const RESULTS_DIR = process.env.SPIKE_RESULTS_DIR || path.join(SPIKE_DIR, 'results');

// Vendor mounts of the proxy origin: URL prefix -> directory. Engine/transport builds are served unmodified.
export const VENDOR = {
  scramjet: '@mercuryworkshop/scramjet/dist',
  'scramjet-controller': '@mercuryworkshop/scramjet-controller/dist',
  'libcurl-transport': '@mercuryworkshop/libcurl-transport/dist', // 2.0.6, ProxyTransport (Scramjet)
  'epoxy-transport': '@mercuryworkshop/epoxy-transport/dist', // 3.0.2, ProxyTransport (Scramjet)
  ultraviolet: '@titaniumnetwork-dev/ultraviolet/dist', // 3.2.10
  'bare-mux': '@mercuryworkshop/bare-mux/dist', // 2.1.9
  'epoxy-transport-bare': 'epoxy-transport-bare/dist', // 2.1.29, BareTransport (UV via bare-mux)
  'libcurl-transport-bare': 'libcurl-transport-bare/dist', // 1.5.2, BareTransport (UV via bare-mux)
};

export const TRANSPORTS = {
  scramjet: ['libcurl', 'epoxy'], // libcurl-transport 2.0.6 / epoxy-transport 3.0.2
  ultraviolet: ['epoxy', 'libcurl'], // epoxy-transport 2.1.29 / libcurl-transport 1.5.2 through bare-mux
};

// Real sites used by the navigation, leak and performance suites.
export const SITES = {
  example: 'https://example.com/',
  wikipedia: 'https://en.wikipedia.org/wiki/Gnome',
  github: 'https://github.com/MercuryWorkshop/scramjet',
  hn: 'https://news.ycombinator.com/',
  mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTTP',
  rust: 'https://www.rust-lang.org/',
  python: 'https://docs.python.org/3/',
};
