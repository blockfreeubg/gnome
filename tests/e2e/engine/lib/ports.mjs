// Every port of the Wave B e2e suites follows ONE variable, E2E_PORT_BASE (default 27500):
//
//   base +0..+40     the runner's stack (lib/config.mjs PORTS: app, proxy, admin, HolyWisp, sentinel, target, realm)
//   base +50         the content-blocker fixture server (E2E_BLOCKER_PORT, servers/blocker-fixtures.mjs, WAVE-B3 §12.1)
//   base +60, +61    reserved for Wave C (docs/WAVE-C.md §9.1: the VPN check fixture, a second test VPN HolyWisp)
//   base +100..+199  the standalone suites (E2E_STANDALONE_PORT_BASE; the runner passes it to them as
//                    BACKEND_E2E_PORT_BASE: backend-https, backend-reload, and backend-*.mjs run by hand)
//   base +200..+202  host-lib.mjs fixtures (HOST_E2E_PORT_BASE: fixture site, leak listener, STUN sink)
//   base +210..+219  shell-lib.mjs servers (SHELL_E2E_PORT_BASE: shell-activation's static sites)
//   base +220..+229  library-lib.mjs's own stack (LIBRARY_E2E_PORT_BASE: app, proxy, HolyWisp)
//
// Each block's own variable still overrides it. Linux hands out outgoing ports from 32768 up, so keep every block
// below that (the default blocks end at 27729).
const DEFAULT_BASE = 27500;

function readInt(name, min = 1024, max = 65000) {
  const v = process.env[name];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}, got ${v}`);
  return n;
}

/** E2E_PORT_BASE, the runner's block (+0..+40). */
export function e2ePortBase() {
  return readInt('E2E_PORT_BASE') ?? DEFAULT_BASE;
}

/** The standalone suites' block: E2E_STANDALONE_PORT_BASE, else E2E_PORT_BASE + 100 (they use +0..+99). */
export function standalonePortBase() {
  return readInt('E2E_STANDALONE_PORT_BASE', 1024, 65400) ?? e2ePortBase() + 100;
}

/** Offsets from E2E_PORT_BASE of the suite libraries' blocks (the header above). */
export const SUITE_PORT_OFFSETS = Object.freeze({ host: 200, shell: 210, library: 220 });

/**
 * The port block of a suite library: its own variable when set (HOST_E2E_PORT_BASE, SHELL_E2E_PORT_BASE,
 * LIBRARY_E2E_PORT_BASE, BACKEND_E2E_PORT_BASE), else derived from E2E_PORT_BASE (backend: the standalone block).
 */
export function suitePortBase(kind) {
  const name = { host: 'HOST_E2E_PORT_BASE', shell: 'SHELL_E2E_PORT_BASE', library: 'LIBRARY_E2E_PORT_BASE', backend: 'BACKEND_E2E_PORT_BASE' }[kind];
  if (!name) throw new Error(`unknown port block ${kind}`);
  const own = readInt(name);
  if (own !== null) return own;
  return kind === 'backend' ? standalonePortBase() : e2ePortBase() + SUITE_PORT_OFFSETS[kind];
}
