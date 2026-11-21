/**
 * Build-time facts of the engine-host bundle. `__GNOME_BUILD__` and `__GNOME_ENGINE_TEST__` are injected by Vite's
 * `define` (lane b's build: the same build id in the app, the engine host and the SW; the test flag only in
 * `npm run build:e2e`). They are declared here, module-locally, so this file also compiles (and the unit tests run)
 * where no build defines them: a missing build id reads as `dev`, a missing test flag as false.
 */
import { CAPABILITIES } from '../shared/engine-protocol';
import { VENDOR_PACKAGES } from '../shared/proxy-origin';
import type { Capability, EngineVersions } from '../shared/engine-protocol';

declare const __GNOME_BUILD__: string | undefined;
declare const __GNOME_ENGINE_TEST__: boolean | undefined;
declare const __GNOME_ENGINE_TEST_CAPABILITIES__: readonly string[] | undefined;

const BUILD_RE = /^[A-Za-z0-9._+-]{1,64}$/;

/** The build id the engine host reports in hello, InitResult.versions and diagnostics. */
export const BUILD: string = typeof __GNOME_BUILD__ === 'string' && BUILD_RE.test(__GNOME_BUILD__) ? __GNOME_BUILD__ : 'dev';

/** True only in builds made for the e2e harness: `test.*` commands exist only then (ENGINE-PROTOCOL §3). */
export const ENGINE_TEST: boolean = typeof __GNOME_ENGINE_TEST__ === 'boolean' ? __GNOME_ENGINE_TEST__ : false;

/**
 * WAVE-B3 D19: capabilities this e2e build offers before production does (`GNOME_ENGINE_TEST_CAPABILITIES`), only
 * known ones and only in e2e builds; [] everywhere else. The core adds them to what it offers and reports.
 */
export const TEST_CAPABILITIES: readonly Capability[] = testCapabilities(
  ENGINE_TEST,
  typeof __GNOME_ENGINE_TEST_CAPABILITIES__ === 'object' && Array.isArray(__GNOME_ENGINE_TEST_CAPABILITIES__) ? __GNOME_ENGINE_TEST_CAPABILITIES__ : [],
);

export function testCapabilities(engineTest: boolean, raw: readonly unknown[]): Capability[] {
  if (!engineTest) return [];
  return CAPABILITIES.filter((c) => raw.includes(c));
}

/** Debug builds (Vite dev server, e2e builds) validate every event they emit against the protocol (a self-check). */
export const SELF_CHECK: boolean = ENGINE_TEST || (import.meta.env?.DEV ?? false);

function pin(dir: string): string {
  const p = VENDOR_PACKAGES.find((v) => v.dir === dir);
  if (!p) throw new Error(`vendor package ${dir} missing from VENDOR_PACKAGES`);
  return p.version;
}

/** The pinned engine and transport builds (ARCHITECTURE §5.4), as InitResult.versions reports them. */
export const VERSIONS: EngineVersions = {
  build: BUILD,
  scramjet: pin('scramjet'),
  scramjetController: pin('scramjet-controller'),
  ultraviolet: pin('ultraviolet'),
  bareMux: pin('bare-mux'),
  transports: {
    scramjet: { libcurl: pin('libcurl-transport'), epoxy: pin('epoxy-transport') },
    ultraviolet: { libcurl: pin('libcurl-transport-bare'), epoxy: pin('epoxy-transport-bare') },
  },
};
