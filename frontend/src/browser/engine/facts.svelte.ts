/**
 * What the engine host reported about itself in its last `init` (InitResult): capabilities, the site permissions it
 * enforces in this browser, versions. Settings offers allow/block rows only for `enforcedPermissions` and hides them
 * until they are known (ENGINE-PROTOCOL §6.14); About shows the versions.
 *
 * Remembered in localStorage with the build id after the first `init`, so Settings knows them before the browser
 * view starts the engine host; facts of another build are ignored (a deploy may change what is enforced).
 *
 * `enforcedPermissions` is the engine host's claim cut down to what this browser can enforce at all
 * (`trustedEnforcedPermissions` with the app's own `browserFamily()`, shared/site-rules.ts): a hostile page can control
 * the engine host (ENGINE-PROTOCOL §1.1), and its claim must not make Settings offer a block this browser ignores.
 */
import {
  CAPABILITIES,
  ENGINE_PERMISSIONS,
  type Capability,
  type EnginePermission,
  type EngineVersions,
  type InitResult,
} from '../../shared/engine-protocol';
import { browserFamily, trustedEnforcedPermissions } from '../../shared/site-rules';

const KEY = 'gnome:engine:v1';

export interface EngineFacts {
  known: boolean;
  build: string | null;
  capabilities: Capability[];
  enforcedPermissions: EnginePermission[];
  versions: EngineVersions | null;
}

function appBuild(): string {
  return typeof __GNOME_BUILD__ === 'string' ? __GNOME_BUILD__ : 'unknown';
}

/** Stored versions are shown as text only; a shape check keeps a corrupted entry from breaking About. */
function isVersions(v: unknown): v is EngineVersions {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  const t = x.transports as Record<string, Record<string, unknown>> | undefined;
  return (
    ['build', 'scramjet', 'scramjetController', 'ultraviolet', 'bareMux'].every((k) => typeof x[k] === 'string' && (x[k] as string).length <= 64) &&
    !!t &&
    ['scramjet', 'ultraviolet'].every((e) => ['libcurl', 'epoxy'].every((k) => typeof t[e]?.[k] === 'string'))
  );
}

function load(): EngineFacts {
  const empty: EngineFacts = { known: false, build: null, capabilities: [], enforcedPermissions: [], versions: null };
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return empty;
    const v = JSON.parse(raw) as Partial<EngineFacts> & { appBuild?: string };
    if (v.appBuild !== appBuild()) return empty;
    return {
      known: true,
      build: typeof v.build === 'string' ? v.build : null,
      capabilities: Array.isArray(v.capabilities) ? v.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c)) : [],
      enforcedPermissions: Array.isArray(v.enforcedPermissions)
        ? trustedEnforcedPermissions(
            v.enforcedPermissions.filter((p): p is EnginePermission => (ENGINE_PERMISSIONS as readonly string[]).includes(p)),
            browserFamily(),
          )
        : [],
      versions: isVersions(v.versions) ? v.versions : null,
    };
  } catch {
    return empty;
  }
}

export const engineFacts: EngineFacts = $state(load());

/** After every successful `init` (the result is already validated). */
export function rememberEngineFacts(r: InitResult, family = browserFamily()): void {
  const enforced = trustedEnforcedPermissions(r.enforcedPermissions, family);
  engineFacts.known = true;
  engineFacts.build = r.versions.build;
  engineFacts.capabilities = [...r.capabilities];
  engineFacts.enforcedPermissions = enforced;
  engineFacts.versions = r.versions;
  try {
    globalThis.localStorage?.setItem(
      KEY,
      JSON.stringify({ appBuild: appBuild(), build: r.versions.build, capabilities: r.capabilities, enforcedPermissions: enforced, versions: r.versions }),
    );
  } catch {
    // Storage full or unavailable: the facts stay in memory for this page.
  }
}

export function hasCapability(c: Capability): boolean {
  return engineFacts.capabilities.includes(c);
}
