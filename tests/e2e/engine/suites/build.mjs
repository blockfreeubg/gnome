// Lane b: the build test (WAVE-B §3 "Tests"), on the build the runner made (`npm run build:e2e`). Browser-independent:
// it runs for the first browser only.
//   graph          both import graphs from <dist>/.vite/gnome-chunks.json (engine host: only src/engine-host/**,
//                  src/shared/**, src/lib/keys.ts and helpers; app: no src/engine-host/**, no src/sw/**); until
//                  frontend/engine/index.html exists, the same check on a fixture engine entry built next to the app
//   graph-control  the check fails on a graph that has the entriesAware bug (synthetic manifest)
//   sw             <dist>/sw.js is one classic script (no import/export/import()), with importScripts
//   engine-html    engine/index.html loads ENGINE_HOST_SCRIPTS in order, then one module, and keeps %GNOME_APP_ORIGINS%
//   vendor         <dist>/vendor/<dir>/ of every VENDOR_PACKAGES entry, byte-identical to node_modules, with licenses
//   build-id       sw.js and the engine-host bundle carry the same __GNOME_BUILD__; test.* only in this e2e build
//   blocker        Wave B step 3 (WAVE-B3 §2 import rules, §10.2 budgets, lane x1): the engine host may also reach
//                  src/extensions/{core,filters,worker,host,cosmetic,privacy,cookies}/** and the pinned libraries;
//                  @ghostery/adblocker and filters/engines.ts only through the dynamic import() in createBlocker; the
//                  app never reaches @ghostery/** and of src/extensions/** only core/, app/ and cookies/fresh-start.ts
//                  (lib/build-check.mjs STEP3_*: the same rules as the runner's check); sizes: engine-host entry
//                  < 300 KB, the blocker chunk and the builder Worker < 400 KB each, sw.js grew ≤ 350 KB
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  STEP3_APP_FORBIDDEN,
  STEP3_ENGINE_ALLOWED,
  buildIdOf,
  checkClassicSw,
  checkGraphs,
  engineHtmlScripts,
  entryChunk,
  readChunks,
  reachable,
} from '../lib/build-check.mjs';
import { readdirSync, statSync } from 'node:fs';

/** What the engine host may reach since Wave B step 3 (WAVE-B3 §2 "Import rules"): one list, in lib/build-check.mjs. */
export { STEP3_ENGINE_ALLOWED };
/** sw.js of the last Wave B step 2 gate build (22,782 bytes, 2026-11-19), the base of the +350 KB budget. */
const SW_STEP2_BYTES = 22_782;
import { viteApi } from '../lib/build.mjs';
import { ENGINE_E2E_DIR, FRONTEND_DIR } from '../lib/config.mjs';

export async function run(ctx) {
  if (ctx.browser !== ctx.firstBrowser) return;
  const dist = ctx.stack.staticDir;
  const parts = new Set(ctx.parts ?? ['graph', 'graph-control', 'sw', 'engine-html', 'vendor', 'build-id', 'blocker']);
  const rec = (test, ok, notes = '') => ctx.record({ test, result: ok ? 'pass' : 'fail', notes });

  if (parts.has('graph')) {
    if (ctx.engineHost) {
      const problems = checkGraphs(readChunks(dist), { engineAllowed: STEP3_ENGINE_ALLOWED, appForbidden: STEP3_APP_FORBIDDEN });
      rec('import graphs: engine host ⟂ app (real entries)', problems.length === 0, problems.slice(0, 8).join('; '));
    } else {
      ctx.record({ test: 'import graphs: engine host ⟂ app (real entries)', result: 'skip', notes: 'frontend/engine/index.html does not exist yet (lane a)' });
    }
    // The fixture entry (lib/fixtures/engine-fixture.ts) as the second input next to the real app.
    const fixture = path.join(ENGINE_E2E_DIR, 'lib', 'fixtures', 'engine-fixture.ts');
    const out = path.join(ctx.runDir, 'fixture-dist');
    const vite = await viteApi();
    const prev = { inputs: process.env.GNOME_BUILD_INPUTS, dist: process.env.GNOME_DIST_DIR, id: process.env.GNOME_BUILD_ID };
    process.env.GNOME_BUILD_INPUTS = JSON.stringify({ app: path.join(FRONTEND_DIR, 'index.html'), engine: fixture });
    process.env.GNOME_DIST_DIR = out;
    process.env.GNOME_BUILD_ID = prev.id ?? '0.0.0+fixture';
    try {
      await vite.build({ root: FRONTEND_DIR, configFile: path.join(FRONTEND_DIR, 'vite.config.ts'), logLevel: 'warn' });
    } finally {
      for (const [k, v] of [['GNOME_BUILD_INPUTS', prev.inputs], ['GNOME_DIST_DIR', prev.dist], ['GNOME_BUILD_ID', prev.id]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const chunks = readChunks(out);
    const facade = Object.values(chunks).find((c) => c.isEntry && String(c.facadeModuleId).endsWith('engine-fixture.ts'))?.facadeModuleId;
    const problems = facade ? checkGraphs(chunks, { engineFacade: facade, engineAllowed: [/tests\/e2e\/engine\/lib\/fixtures\//] }) : ['no fixture entry chunk'];
    const mods = facade ? reachable(chunks, entryChunk(chunks, facade)).modules : [];
    rec('import graphs: fixture engine entry ⟂ app (vite.config.ts codeSplitting)', problems.length === 0, problems.length ? problems.slice(0, 8).join('; ') : `engine graph: ${mods.length} modules`);
  }

  if (parts.has('graph-control')) {
    // What rolldown produced before entriesAware: one shell chunk with both entries' initial modules.
    const bad = {
      'assets/app.js': { isEntry: true, facadeModuleId: 'index.html', imports: ['assets/shell.js'], dynamicImports: [], modules: ['src/main.ts'] },
      'assets/engine.js': { isEntry: true, facadeModuleId: 'engine/index.html', imports: ['assets/shell.js'], dynamicImports: [], modules: ['src/engine-host/main.ts'] },
      'assets/shell.js': { isEntry: false, facadeModuleId: null, imports: [], dynamicImports: [], modules: ['src/app/App.svelte', 'src/engine-host/core.ts', 'src/shared/engine-protocol.ts'] },
    };
    const problems = checkGraphs(bad);
    rec('the graph check catches a shared shell chunk', problems.some((p) => p.includes('app graph contains src/engine-host/core.ts')) && problems.some((p) => p.includes('engine-host graph contains src/app/App.svelte')), problems.join('; '));
  }

  const swFile = path.join(dist, 'sw.js');
  const sw = existsSync(swFile) ? readFileSync(swFile, 'utf8') : '';
  if (parts.has('sw')) {
    const problems = existsSync(swFile) ? checkClassicSw(sw) : ['sw.js missing'];
    rec('dist/sw.js is a classic script', problems.length === 0, problems.join('; ') || `${sw.length} bytes`);
    const order = sw.indexOf('skipWaiting=()=>Promise.resolve()');
    rec('skipWaiting is neutralized before importScripts', order >= 0 && order < sw.indexOf('importScripts('), order < 0 ? 'neutralization not found' : '');
  }

  if (parts.has('engine-html')) {
    const file = path.join(dist, 'engine', 'index.html');
    if (!existsSync(file)) ctx.record({ test: 'engine/index.html scripts = ENGINE_HOST_SCRIPTS', result: 'skip', notes: 'not built yet (lane a)' });
    else {
      const { scripts, module, placeholder } = engineHtmlScripts(readFileSync(file, 'utf8'));
      rec('engine/index.html scripts = ENGINE_HOST_SCRIPTS', JSON.stringify(scripts) === JSON.stringify(ctx.contract.ENGINE_HOST_SCRIPTS), JSON.stringify(scripts));
      rec('engine/index.html has one bundled module script', !!module && /^\/assets\/.+\.js$/.test(module), String(module));
      rec('engine/index.html keeps %GNOME_APP_ORIGINS% for gnome-server', placeholder);
    }
    rec('engine/uv.config.js is copied from public/', existsSync(path.join(dist, 'engine', 'uv.config.js')) && readFileSync(path.join(dist, 'engine', 'uv.config.js'), 'utf8') === readFileSync(path.join(FRONTEND_DIR, 'public', 'engine', 'uv.config.js'), 'utf8'));
  }

  if (parts.has('vendor')) {
    const { checkVendor } = await import(path.join(FRONTEND_DIR, 'scripts', 'copy-vendor.mjs'));
    const problems = checkVendor({ dist });
    rec('vendor/ is byte-identical to node_modules, with LICENSE files', problems.length === 0, problems.slice(0, 8).join('; ') || `${ctx.contract.VENDOR_PACKAGES.length} packages`);
    const missing = ctx.contract.VENDOR_PACKAGES.filter((v) => !existsSync(path.join(dist, 'vendor', v.dir, 'LICENSE'))).map((v) => v.dir);
    rec('every VENDOR_PACKAGES entry has vendor/<dir>/', missing.length === 0, missing.join(', '));
  }

  if (parts.has('build-id')) {
    const id = buildIdOf(sw);
    rec('sw.js carries a build id', !!id, String(id));
    if (!ctx.engineHost) ctx.record({ test: 'one build id in sw.js and the engine host', result: 'skip', notes: 'engine host not built yet (lane a)' });
    else {
      const chunks = readChunks(dist);
      const files = reachable(chunks, entryChunk(chunks, 'engine/index.html')).chunks;
      const hit = files.some((f) => existsSync(path.join(dist, f)) && readFileSync(path.join(dist, f), 'utf8').includes(String(id)));
      rec('one build id in sw.js and the engine host', hit, String(id));
    }
  }

  if (parts.has('blocker') && ctx.engineHost) {
    const chunks = readChunks(dist);
    const engine = entryChunk(chunks, 'engine/index.html');
    const app = entryChunk(chunks, 'index.html');
    // The engine host's static graph (entry + static imports) must not hold the library or engines.ts.
    const staticOf = (start) => {
      const seen = new Set();
      const stack = [start];
      const mods = [];
      while (stack.length) {
        const f = stack.pop();
        if (seen.has(f) || !chunks[f]) continue;
        seen.add(f);
        mods.push(...(chunks[f].modules ?? []));
        stack.push(...(chunks[f].imports ?? []));
      }
      return { files: [...seen], mods };
    };
    const st = staticOf(engine);
    const eagerLib = st.mods.filter((m) => /^node_modules\/@ghostery\/adblocker\/|^src\/extensions\/filters\/engines\.ts$/.test(m));
    rec('blocker: @ghostery/adblocker and engines.ts reach the engine host only through a dynamic import()', eagerLib.length === 0 && reachable(chunks, engine).modules.some((m) => m.startsWith('node_modules/@ghostery/adblocker/')), eagerLib.slice(0, 5).join(', ') || `static graph: ${st.mods.length} modules`);
    const appMods = reachable(chunks, app).modules;
    const appBad = appMods.filter((m) => STEP3_APP_FORBIDDEN.some((re) => re.test(m)));
    rec('blocker: the app graph holds no @ghostery/** and of src/extensions/** only core/, app/ and cookies/fresh-start.ts', appBad.length === 0, appBad.slice(0, 5).join(', ') || `${appMods.length} modules`);
    const size = (f) => (existsSync(path.join(dist, f)) ? statSync(path.join(dist, f)).size : null);
    const assets = readdirSync(path.join(dist, 'assets'));
    const worker = assets.find((f) => /^builder\.worker-.*\.js$/.test(f));
    const enginesChunk = Object.entries(chunks).find(([, c]) => c.isDynamicEntry && (c.modules ?? []).includes('src/extensions/filters/engines.ts'))?.[0];
    const sizes = { entry: size(engine), blocker: enginesChunk ? size(enginesChunk) : null, worker: worker ? size(`assets/${worker}`) : null, sw: sw.length };
    const ok = sizes.entry !== null && sizes.entry < 300_000 && sizes.blocker !== null && sizes.blocker < 400_000 && sizes.worker !== null && sizes.worker < 400_000 && sizes.sw - SW_STEP2_BYTES <= 350_000;
    rec('blocker: size budgets (§10.2): entry < 300 KB, blocker chunk and Worker < 400 KB, sw.js +≤ 350 KB', ok, `${JSON.stringify(sizes)} bytes; sw.js +${sizes.sw - SW_STEP2_BYTES}`);
    // The SW build carries the library but no DOM-only parts (@ghostery/adblocker-content is a DOM helper).
    rec('blocker: sw.js has no @ghostery/adblocker-content (no DOM in the SW)', !/adblocker-content|DOMMonitor/.test(sw), '');
  }
}
