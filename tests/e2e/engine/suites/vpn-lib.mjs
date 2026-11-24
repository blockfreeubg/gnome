// Lane t's helpers for the vpn-ui suite (docs/WAVE-C.md §9.1, §9.4): the check service fixture on
// E2E_VPN_CHECK_PORT (default E2E_PORT_BASE + 60), a second live location's HolyWisp on E2E_HOLYWISP_VPN2_PORT
// (E2E_PORT_BASE + 61, TEST-ONLY allow-loopback overlay, lib/stack.mjs startHolyWisp), and the profiles file with
// e2e-dead first, then e2e-vpn, then e2e-vpn2 (the Automatic rule has a down location to skip and a second live one).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST, PORT_BASE, PORTS } from '../lib/config.mjs';
import { startHolyWisp } from '../lib/stack.mjs';
import { startVpnCheck } from '../servers/vpn-check.mjs';

const int = (name, d) => (process.env[name] ? Number(process.env[name]) : d);
export const VPN_CHECK_PORT = int('E2E_VPN_CHECK_PORT', PORT_BASE + 60);
export const VPN2_PORT = int('E2E_HOLYWISP_VPN2_PORT', PORT_BASE + 61);
export { startVpnCheck };

/** The second live location's HolyWisp (loopback allowed: the target site and the check fixture are local). */
export function startVpn2(runDir) {
  return startHolyWisp({ name: 'vpn2', port: VPN2_PORT, runDir, loopback: true });
}

/** Profiles e2e-dead, e2e-vpn, e2e-vpn2 (in that order). */
export function writeThreeProfiles(runDir, profiles) {
  const file = path.join(runDir, 'vpn-profiles-3.toml');
  const p = (id, label, port) =>
    `[[profile]]\nid = "${id}"\nlabel = "${label}"\ncountry_code = "se"\ncountry = "Sweden"\ncity = "E2E"\nprovider_note = "e2e test upstream"\nwisp_upstream = "${HOST}:${port}"\n`;
  writeFileSync(file, [p(profiles.dead, 'E2E · down', PORTS.dead), p(profiles.live, 'E2E · live', PORTS.vpn), p('e2e-vpn2', 'E2E · live 2', VPN2_PORT)].join('\n'));
  return file;
}
