/// <reference types="svelte" />
/// <reference types="vite/client" />

/** Version from package.json, injected by Vite (vite.config.ts `define`). */
declare const __GNOME_VERSION__: string;

/**
 * Build id, computed once per `npm run build` (the npm script exports `GNOME_BUILD_ID`) and given to both Vite builds
 * (the app/engine-host build and the service-worker build), so the engine host can tell whether the active `/sw.js`
 * belongs to its own build (ENGINE-PROTOCOL §2.5). At most 64 characters (`sw-hello.build`).
 */
declare const __GNOME_BUILD__: string;

/**
 * True only in e2e builds (`npm run build:e2e`, `GNOME_ENGINE_TEST=1`): the engine host then answers the `test.*`
 * commands. Production builds and unit tests have it false, and the bundler removes the guarded code.
 */
declare const __GNOME_ENGINE_TEST__: boolean;

/**
 * WAVE-B3 D19: capabilities an e2e build offers before production does (`GNOME_ENGINE_TEST_CAPABILITIES=blocker`
 * with `GNOME_ENGINE_TEST=1`); [] in every other build. The app registers the `extensions` feature in e2e builds whose
 * list includes `blocker`; the engine host adds them to InitResult.capabilities. Removed in the step-3 integration.
 */
declare const __GNOME_ENGINE_TEST_CAPABILITIES__: readonly string[];
