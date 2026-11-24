/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Logger, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * The build id (`__GNOME_BUILD__`): `npm run build` computes it once and exports `GNOME_BUILD_ID`, so the app/engine-host
 * build and the service-worker build (vite.sw.config.ts) carry the same value. Without it (dev server, vitest, a bare
 * `vite build`) it is derived from the version and the start time of this process.
 */
export function buildId(): string {
  const id = process.env.GNOME_BUILD_ID?.trim() || `${pkg.version}-dev-${Date.now().toString(36)}`;
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(id)) throw new Error(`GNOME_BUILD_ID must be 1-64 characters of [A-Za-z0-9._+-], got ${JSON.stringify(id)}`);
  return id;
}

/** Compile-time constants shared by every bundle (vite-env.d.ts). `__GNOME_ENGINE_TEST__` only for e2e builds. */
export function gnomeDefines(id: string = buildId()): Record<string, string> {
  return {
    __GNOME_VERSION__: JSON.stringify(pkg.version),
    __GNOME_BUILD__: JSON.stringify(id),
    __GNOME_ENGINE_TEST__: JSON.stringify(process.env.GNOME_ENGINE_TEST === '1'),
  };
}

/**
 * Backend for the dev/preview `/api` proxy (docs/API.md). Only the app origin is proxied: the engine host and
 * `/wisp/` live on the proxy origin (docs/ARCHITECTURE.md §4.6), which the backend serves itself
 * (`GNOME_PROXY_BIND`, e.g. http://127.0.0.1:8081) and which the app learns from GET /api/config.
 */
const BACKEND = process.env.GNOME_DEV_BACKEND ?? 'http://127.0.0.1:8080';

/** TCP reachability of the backend, cached briefly so a page load's burst of requests probes once. */
function backendProbe(target: string): () => Promise<boolean> {
  const url = new URL(target);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  let cached: { at: number; up: boolean } | null = null;
  let pending: Promise<boolean> | null = null;
  return () => {
    if (cached && Date.now() - cached.at < 1500) return Promise.resolve(cached.up);
    pending ??= new Promise<boolean>((resolve) => {
      const socket = connect({ host: url.hostname, port });
      const done = (up: boolean): void => {
        socket.destroy();
        cached = { at: Date.now(), up };
        pending = null;
        resolve(up);
      };
      socket.setTimeout(400, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    return pending;
  };
}

/**
 * Answers `/api/*` with a plain `502` while no backend listens on BACKEND, instead of letting the proxy log a stack
 * trace for every request. The app treats it like any unreachable server (status "down", no console noise). One
 * terminal line is printed when the backend goes away and one when it comes back.
 */
function devBackend(): Plugin {
  const probe = backendProbe(BACKEND);
  let lastState: boolean | null = null;
  const report = (logger: Logger, up: boolean): void => {
    if (up === lastState) return;
    if (up) {
      if (lastState === false) logger.info(`[gnome] backend at ${BACKEND} is reachable again`, { timestamp: true });
    } else {
      logger.warn(
        `[gnome] no backend at ${BACKEND}: /api requests answer 502 (start gnome-server or set GNOME_DEV_BACKEND)`,
        { timestamp: true },
      );
    }
    lastState = up;
  };
  const middleware =
    (logger: Logger) =>
    (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
      if (!req.url || !/^\/api(\/|$|\?)/.test(req.url)) return next();
      void probe().then((up) => {
        report(logger, up);
        if (up) return next();
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`GNOME backend not reachable at ${BACKEND}\n`);
      });
    };
  return {
    name: 'gnome-dev-backend',
    configureServer(server) {
      server.middlewares.use(middleware(server.config.logger));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(server.config.logger));
    },
  };
}

const apiProxy = { '/api': { target: BACKEND, changeOrigin: false } };

/**
 * Writes `<dist>/.vite/gnome-chunks.json`: every chunk with its entry flags, static and dynamic imports and the source
 * modules in it (paths relative to frontend/). The build test (tests/e2e/engine/suites/build.mjs) walks both pages'
 * import graphs with it: the Vite manifest names chunks, not the modules inside them. Dot-directories are never
 * served by gnome-server.
 */
/** Chunk graphs of the worker bundles of the current build (filled by `chunkGraph(…, true)` in `worker.plugins`). */
const workerGraph: Record<string, unknown> = {};

export function chunkGraph(fileName = '.vite/gnome-chunks.json', direct = false): Plugin {
  const rel = (id: string | null): string | null => {
    if (id === null) return null;
    if (id.startsWith('\0')) return id;
    const clean = id.split('?')[0] ?? id;
    return clean.startsWith(ROOT) ? clean.slice(ROOT.length) : clean;
  };
  return {
    name: 'gnome-chunk-graph',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks: Record<string, unknown> = {};
      for (const [file, c] of Object.entries(bundle)) {
        if (c.type !== 'chunk') continue;
        chunks[file] = {
          name: c.name,
          isEntry: c.isEntry,
          isDynamicEntry: c.isDynamicEntry,
          facadeModuleId: rel(c.facadeModuleId),
          imports: c.imports,
          dynamicImports: c.dynamicImports,
          modules: c.moduleIds.map(rel),
        };
      }
      if (direct) {
        // A worker bundle (WAVE-D §4.6): built while the main build transforms its importer, before Vite empties and
        // writes the output, so its graph is kept here and the main build emits it as .vite/gnome-worker-chunks.json.
        Object.assign(workerGraph, chunks);
        return;
      }
      this.emitFile({ type: 'asset', fileName, source: `${JSON.stringify(chunks, null, 1)}\n` });
      if (fileName === '.vite/gnome-chunks.json' && Object.keys(workerGraph).length) {
        const sorted = Object.fromEntries(Object.keys(workerGraph).sort().map((k) => [k, workerGraph[k]]));
        this.emitFile({ type: 'asset', fileName: '.vite/gnome-worker-chunks.json', source: `${JSON.stringify(sorted, null, 1)}\n` });
      }
    },
  };
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Output directory of every build step (`GNOME_DIST_DIR`, default `dist/`): the e2e runner builds into its own. */
export function distDir(): string {
  return process.env.GNOME_DIST_DIR?.trim() || `${ROOT}dist`;
}

/**
 * Vite multi-page inputs (ARCHITECTURE §3): the app (`index.html`) and the engine host (`engine/index.html`, served
 * at <proxy origin>/engine/), which joins once its page exists (WAVE-B §8 step 3) so a build never points at a missing
 * file. `--mode engine` (npm run dev:engine) builds only the engine host and leaves dist/index.html alone.
 * `GNOME_BUILD_INPUTS` (JSON name → path) replaces the inputs (the build test's fixture entries).
 */
export function buildInputs(mode: string): Record<string, string> {
  const override = process.env.GNOME_BUILD_INPUTS;
  if (override) return JSON.parse(override) as Record<string, string>;
  const inputs: Record<string, string> = {};
  if (mode !== 'engine') inputs.app = `${ROOT}index.html`;
  if (existsSync(`${ROOT}engine/index.html`)) inputs.engine = `${ROOT}engine/index.html`;
  if (!Object.keys(inputs).length) throw new Error('vite --mode engine needs frontend/engine/index.html');
  return inputs;
}

export default defineConfig(({ mode }) => ({
  plugins: [svelte(), devBackend(), chunkGraph()],
  define: gnomeDefines(),
  server: {
    host: '127.0.0.1',
    proxy: apiProxy,
  },
  preview: {
    host: '127.0.0.1',
    proxy: apiProxy,
  },
  build: {
    outDir: distDir(),
    // The engine-host watch build (dev:engine) writes next to the app build and must not delete it.
    emptyOutDir: mode !== 'engine',
    // Read by the build test (tests/e2e/engine/suites/build.mjs). gnome-server never serves dot-directories.
    manifest: true,
    target: 'es2022',
    sourcemap: false,
    cssMinify: 'lightningcss',
    assetsInlineLimit: 2048,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 300,
    rolldownOptions: {
      input: mode === 'test' ? undefined : buildInputs(mode),
      output: {
        // The Svelte runtime is needed by every page: one stable, cacheable chunk instead of being folded into
        // whichever shared module the bundler happens to name the chunk after.
        codeSplitting: {
          groups: [
            { name: 'svelte', test: /node_modules[\\/]svelte[\\/]/, priority: 2 },
            // entriesAware: without it rolldown puts the initial modules of EVERY entry into one shell chunk that both
            // pages load, so the engine host would run the app's main.ts and the app the engine host's (reproduced
            // with Vite 8.3.7 / rolldown 1.2.18). The build test checks both import graphs.
            { name: 'shell', tags: ['$initial'], priority: 1, entriesAware: true },
          ],
        },
      },
    },
  },
  // The content blocker's builder Worker (src/extensions/worker/builder.worker.ts, WAVE-B3 D8): a module Worker.
  // Its chunk graph goes to .vite/gnome-worker-chunks.json (the third-party notices and bundle-report read it).
  worker: { format: 'es' as const, plugins: () => [chunkGraph('.vite/gnome-worker-chunks.json', true)] },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
  },
}));
