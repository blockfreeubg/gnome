#!/usr/bin/env node
/**
 * Versions of the C and Rust code compiled into the vendored wasm (WAVE-D D24, row AU5).
 *
 *   node scripts/audit/embedded.mjs [--json FILE]
 *
 * Records what can be read from the installed files without running them: the libcurl.js and epoxy-tls package
 * versions and the curl version string inside libcurl.wasm. Not recorded yet (status "skipped", never "pass"): the
 * Mbed TLS, nghttp2 and brotli versions and the CA bundle's date, which libcurl.js formats at run time (they need
 * one engine-host init in a test browser), and the `cargo deny check advisories` run on epoxy-tls's Cargo.lock at its
 * scripts/third-party-sources.json revision (needs that checkout).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NM = path.join(ROOT, 'frontend', 'node_modules');

function version(pkg) {
  const f = path.join(NM, pkg, 'package.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).version : null;
}

function curlVersion() {
  const f = path.join(NM, 'libcurl.js', 'libcurl.wasm');
  if (!existsSync(f)) return null;
  const m = /(\d+\.\d+\.\d+(?:-DEV)?)\0/.exec(readFileSync(f).toString('latin1').match(/\d+\.\d+\.\d+-DEV\0|libcurl\/\d+\.\d+\.\d+/)?.[0] ?? '');
  return m?.[1] ?? null;
}

const out = {
  'libcurl.js': version('libcurl.js'),
  curl: curlVersion(),
  '@mercuryworkshop/epoxy-tls': version('@mercuryworkshop/epoxy-tls'),
  runtime_versions: { status: 'skipped', reason: 'Mbed TLS, nghttp2, brotli and the CA bundle date need one engine-host init in a test browser' },
  epoxy_tls_advisories: { status: 'skipped', reason: "needs epoxy-tls's Cargo.lock at its scripts/third-party-sources.json revision" },
};
const json = process.argv.indexOf('--json');
if (json > 0) writeFileSync(process.argv[json + 1], `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out)}\n`);
