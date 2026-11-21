// Builds the frontend for the e2e runner: `npm run build:e2e` (GNOME_ENGINE_TEST=1, and
// GNOME_ENGINE_TEST_CAPABILITIES=blocker unless the environment sets it: WAVE-B3 D19) into a directory of the run,
// then the e2e driver page (lib/driver/) into `<dist>/e2e-driver/`, then the build test's checks (build-check.mjs).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../../spike-engine-host/lib/procs.mjs';
import { checkBuild } from './build-check.mjs';
import { ENGINE_E2E_DIR, FRONTEND_DIR } from './config.mjs';

const DRIVER_DIR = path.join(ENGINE_E2E_DIR, 'lib', 'driver');

export async function viteApi() {
  const require = createRequire(path.join(FRONTEND_DIR, 'package.json'));
  return import(pathToFileURL(require.resolve('vite')).href);
}

/** The contract constants the checks compare with (evaluated through Vite's SSR loader: they are TypeScript). */
export async function loadContract() {
  const vite = await viteApi();
  const server = await vite.createServer({ root: FRONTEND_DIR, configFile: false, logLevel: 'silent', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const po = await server.ssrLoadModule('/src/shared/proxy-origin.ts');
    const ep = await server.ssrLoadModule('/src/shared/engine-protocol.ts');
    const tr = await server.ssrLoadModule('/src/shared/transport.ts');
    return { ...po, ...ep, transport: tr };
  } finally {
    await server.close();
  }
}

export async function buildDriver(dist) {
  const vite = await viteApi();
  const out = path.join(dist, 'e2e-driver');
  await vite.build({
    configFile: false,
    root: FRONTEND_DIR,
    logLevel: 'warn',
    publicDir: false,
    define: { __GNOME_BUILD__: JSON.stringify('e2e-driver'), __GNOME_ENGINE_TEST__: 'true', __GNOME_VERSION__: JSON.stringify('e2e') },
    build: {
      outDir: out,
      emptyOutDir: true,
      copyPublicDir: false,
      target: 'es2022',
      minify: false,
      reportCompressedSize: false,
      lib: { entry: path.join(DRIVER_DIR, 'driver.ts'), formats: ['es'], fileName: () => 'driver.js' },
    },
  });
  mkdirSync(out, { recursive: true });
  for (const f of ['index.html', 'driver.css']) copyFileSync(path.join(DRIVER_DIR, f), path.join(out, f));
  return out;
}

/**
 * `npm run build:e2e` into `dist` (GNOME_DIST_DIR), the driver, and the checks. Returns {problems, buildId,
 * engineHost} (engineHost: whether frontend/engine/index.html exists yet, i.e. the engine host was built).
 */
export async function buildFrontend({ dist, log = console.log, contract }) {
  const t0 = Date.now();
  log(`building the frontend (npm run build:e2e) into ${dist} ...`);
  try {
    // WAVE-B3 D19: e2e builds offer the content blocker through the build-time switch (frontend/vite.config.ts
    // turns it into __GNOME_ENGINE_TEST_CAPABILITIES__), unless the environment sets the variable (empty = without).
    const env = { GNOME_ENGINE_TEST_CAPABILITIES: 'blocker', ...process.env, GNOME_DIST_DIR: dist };
    await run('npm', ['run', 'build:e2e'], { cwd: FRONTEND_DIR, env, maxBuffer: 64 << 20 });
  } catch (err) {
    throw new Error(`npm run build:e2e failed:\n${String(err.stdout ?? '').slice(-3000)}\n${String(err.stderr ?? '').slice(-3000)}`);
  }
  await buildDriver(dist);
  const engineHost = existsSync(path.join(dist, 'engine', 'index.html'));
  // checkBuild applies Wave B step 3's import rules (build-check.mjs STEP3_*, the same lists suites/build.mjs uses).
  const result = engineHost
    ? checkBuild(dist, contract)
    : { problems: ['engine/index.html is not built yet (lane a adds frontend/engine/index.html)'], buildId: null };
  const shown = result.problems.slice(0, 5).join('; ');
  log(`build done in ${Math.round((Date.now() - t0) / 1000)} s${result.problems.length ? `; ${result.problems.length} build-check problem(s): ${shown}${result.problems.length > 5 ? '; …' : ''}` : ''}`);
  return { ...result, engineHost };
}
