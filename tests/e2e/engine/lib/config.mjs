// Configuration of the Wave B e2e runner (tests/e2e/engine/run.mjs). Every port comes from the environment:
// E2E_PORT_BASE (default 27500) plus fixed offsets, each overridable on its own; the suite libraries' blocks follow
// the same base (lib/ports.mjs).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2ePortBase } from './ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_E2E_DIR = path.resolve(here, '..');
export const E2E_DIR = path.resolve(ENGINE_E2E_DIR, '..');
export const REPO_DIR = path.resolve(E2E_DIR, '..', '..');
export const FRONTEND_DIR = path.join(REPO_DIR, 'frontend');

const int = (name, dflt, min = 1024, max = 65535) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}, got ${v}`);
  return n;
};

export const PORT_BASE = e2ePortBase();
const at = (name, offset) => int(name, PORT_BASE + offset);

export const PORTS = {
  app: at('E2E_APP_PORT', 0), // gnome-server GNOME_BIND (app origin)
  proxy: at('E2E_PROXY_PORT', 1), // gnome-server GNOME_PROXY_BIND (proxy origin)
  admin: at('E2E_ADMIN_PORT', 2), // gnome-server admin listener (loopback)
  holywisp: at('E2E_HOLYWISP_PORT', 10), // HolyWisp, the direct upstream (GNOME_WISP_UPSTREAM)
  vpn: at('E2E_HOLYWISP_VPN_PORT', 11), // HolyWisp behind the VPN profile `e2e-vpn` (suites can stop/start it)
  dead: at('E2E_DEAD_UPSTREAM_PORT', 12), // upstream of the VPN profile `e2e-dead`: never started
  sentinel: at('E2E_SENTINEL_PORT', 20), // leak sentinel: the browsers' only route to non-loopback hosts
  target: at('E2E_TARGET_PORT', 30), // the spike's local target site (servers/target.mjs), via the VPN profile only
  realm: at('E2E_REALM_FIXTURE_PORT', 40), // the sw suite's realm fixtures (servers/realm-fixtures.mjs), via the VPN profile only
  blocker: at('E2E_BLOCKER_PORT', 50), // the content-blocker fixtures (servers/blocker-fixtures.mjs, WAVE-B3 §12.1), via the VPN profile only
};

export const HOST = '127.0.0.1';
export const APP_ORIGIN = `http://${HOST}:${PORTS.app}`;
export const PROXY_ORIGIN = `http://${HOST}:${PORTS.proxy}`;
export const ADMIN_ORIGIN = `http://${HOST}:${PORTS.admin}`;

/** VPN profiles the runner configures (GNOME_VPN_PROFILES): one whose HolyWisp runs, one whose never does. */
export const PROFILES = { live: 'e2e-vpn', dead: 'e2e-dead' };

export const HOLYWISP = {
  bin: process.env.HOLYWISP_BIN || path.join(REPO_DIR, 'services', 'holywisp', 'build', os.arch() === 'arm64' ? 'aarch64' : 'x86_64', 'holywisp'),
  conf: path.join(REPO_DIR, 'services', 'holywisp', 'gnome.conf'),
  dockerfile: path.join(REPO_DIR, 'services', 'holywisp', 'Dockerfile'),
  // host (default here: the static binary as this user) or docker (the spike's locked-down container).
  runner: process.env.HOLYWISP_RUNNER || 'host',
};

/** gnome-server: GNOME_SERVER_BIN, else $CARGO_TARGET_DIR/release/gnome-server (built with --build-server). */
export const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR || path.join(REPO_DIR, 'target');
export const SERVER_BIN = process.env.GNOME_SERVER_BIN || path.join(CARGO_TARGET_DIR, 'release', 'gnome-server');

/** Results and scratch output: E2E_RESULTS_DIR (default tests/e2e/engine/results/, git-ignored). */
export const RESULTS_DIR = process.env.E2E_RESULTS_DIR || path.join(ENGINE_E2E_DIR, 'results');

export const SITES = {
  example: 'https://example.com/',
  wikipedia: 'https://en.wikipedia.org/wiki/Gnome',
};
