/**
 * The build test's checks (WAVE-B §3 "Tests"; used by suites/build.mjs and run.mjs before any browser starts):
 * - both pages' import graphs from `<dist>/.vite/gnome-chunks.json` (written by frontend/vite.config.ts): the engine
 *   host reaches only src/engine-host/**, src/shared/**, src/lib/keys.ts and Vite's/rolldown's helpers, plus what the
 *   caller allows (`engineAllowed`); the app reaches no src/engine-host/** and no src/sw/** (the codeSplitting
 *   `entriesAware` rule), nor what the caller forbids (`appForbidden`);
 * - `sw.js` is one classic script (no import/export, no import());
 * - `engine/index.html` loads exactly ENGINE_HOST_SCRIPTS in order before its module and keeps %GNOME_APP_ORIGINS%;
 * - `vendor/<dir>/` exists for every VENDOR_PACKAGES entry (copy-vendor --check compares the bytes);
 * - one build id in the engine-host bundle and in sw.js.
 * Since Wave B step 3 both graphs follow the import rules of docs/WAVE-B3.md §2 (STEP3_ENGINE_ALLOWED,
 * STEP3_APP_FORBIDDEN below): one list for the runner's check before any browser starts (checkBuild, lib/build.mjs) and
 * for suites/build.mjs, so a real violation is reported by both and nothing that the rules allow is.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ENGINE_ALLOWED = [/^src\/engine-host\//, /^src\/shared\//, /^src\/lib\/keys\.ts$/, /^engine\/index\.html$/];
const HELPER = /^\0|vite\/preload-helper|rolldown\/runtime|^\\0/;
const APP_FORBIDDEN = [/^src\/engine-host\//, /^src\/sw\//];

/**
 * WAVE-B3 §2 "Import rules": what the engine host (and its builder Worker) may reach besides ENGINE_ALLOWED: the
 * step-3 runtime outside its app and SW parts, the pinned libraries (@ghostery/**, tldts-*) and their own
 * dependencies (@remusao/**). `@ghostery/adblocker` reaching it only through the dynamic import() in createBlocker is
 * checked by suites/build.mjs.
 */
export const STEP3_ENGINE_ALLOWED = Object.freeze([
  /^src\/extensions\/(core|filters|worker|host|cosmetic|privacy|cookies)\//,
  /^node_modules\/@ghostery\//,
  /^node_modules\/tldts-(experimental|core)\//,
  /^node_modules\/@remusao\//,
]);
/**
 * WAVE-B3 §2: the app may reach src/extensions/{core,app}/** and src/extensions/cookies/fresh-start.ts only (never
 * filters, worker, sw, host, nor the window parts of cosmetic, privacy and cookies), and never @ghostery/**
 * (tldts-experimental may, lazily).
 */
export const STEP3_APP_FORBIDDEN = Object.freeze([/^node_modules\/@ghostery\//, /^src\/extensions\/(?!core\/|app\/|cookies\/fresh-start\.ts$)/]);

/** Every module reachable from `entryFile` through static and dynamic imports. */
export function reachable(chunks, entryFile) {
  const seen = new Set();
  const modules = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const c = chunks[f];
    if (!c) continue;
    for (const m of c.modules ?? []) modules.add(m);
    stack.push(...(c.imports ?? []), ...(c.dynamicImports ?? []));
  }
  return { chunks: [...seen], modules: [...modules] };
}

/** Entry chunk file of an input (by facade module, e.g. `index.html`, `engine/index.html`, or a fixture path). */
export function entryChunk(chunks, facade) {
  return Object.entries(chunks).find(([, c]) => c.isEntry && c.facadeModuleId === facade)?.[0] ?? null;
}

/**
 * Problems with the two graphs (empty = fine). `engineFacade` may be a fixture entry; `engineAllowed` and
 * `appForbidden` extend the step-2 rules (the real entries take the step-3 rules, STEP3_*).
 */
export function checkGraphs(chunks, { appFacade = 'index.html', engineFacade = 'engine/index.html', engineAllowed = [], appForbidden = [] } = {}) {
  const problems = [];
  const app = entryChunk(chunks, appFacade);
  const engine = entryChunk(chunks, engineFacade);
  if (!app) problems.push(`no entry chunk for ${appFacade}`);
  if (!engine) problems.push(`no entry chunk for ${engineFacade}`);
  if (app) {
    const forbidden = [...APP_FORBIDDEN, ...appForbidden];
    for (const m of reachable(chunks, app).modules) if (forbidden.some((re) => re.test(m))) problems.push(`app graph contains ${m}`);
  }
  if (engine) {
    const allowed = [...ENGINE_ALLOWED, ...engineAllowed];
    for (const m of reachable(chunks, engine).modules) {
      if (HELPER.test(m) || allowed.some((re) => re.test(m))) continue;
      problems.push(`engine-host graph contains ${m}`);
    }
  }
  return problems;
}

export function readChunks(dist) {
  const f = path.join(dist, '.vite', 'gnome-chunks.json');
  if (!existsSync(f)) throw new Error(`${f} missing: build with frontend/vite.config.ts (npm run build)`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** sw.js must be a classic script: no static import/export and no import(). */
export function checkClassicSw(source) {
  const problems = [];
  if (/(^|[;\n}])\s*import\s*[\w{*'"]/m.test(source)) problems.push('sw.js has an import statement');
  if (/(^|[;\n}])\s*export\s*[\w{*]/m.test(source)) problems.push('sw.js has an export statement');
  if (/\bimport\s*\(/.test(source)) problems.push('sw.js has a dynamic import()');
  if (!/importScripts\(/.test(source)) problems.push('sw.js does not call importScripts');
  return problems;
}

/** The classic scripts of engine/index.html in order, and whether the module and the placeholder are there. */
export function engineHtmlScripts(html) {
  const scripts = [];
  let module = null;
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const src = /\bsrc\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? null;
    if (/\btype\s*=\s*"module"/i.test(attrs)) module ??= src;
    else if (src) scripts.push(src);
    else scripts.push('(inline)');
  }
  return { scripts, module, placeholder: html.includes('%GNOME_APP_ORIGINS%') };
}

/** The build id `npm run build` writes (`<version>+<yyyymmddHHMMSS>.<pid>`) as found in a bundle, or null. */
export function buildIdOf(source) {
  const m = /[`"']([0-9A-Za-z._-]{1,32}\+[0-9]{14}\.[0-9]{1,10})[`"']/.exec(source);
  return m?.[1] ?? null;
}

/**
 * All checks on a finished build directory. `contract`: { VENDOR_PACKAGES, ENGINE_HOST_SCRIPTS }. The graphs follow
 * the step-3 import rules unless the caller passes its own.
 */
export function checkBuild(dist, contract, { engineFacade = 'engine/index.html', engineAllowed = STEP3_ENGINE_ALLOWED, appForbidden = STEP3_APP_FORBIDDEN } = {}) {
  const problems = [];
  const chunks = readChunks(dist);
  problems.push(...checkGraphs(chunks, { engineFacade, engineAllowed, appForbidden }));
  const sw = path.join(dist, 'sw.js');
  if (!existsSync(sw)) problems.push('sw.js missing');
  const swSource = existsSync(sw) ? readFileSync(sw, 'utf8') : '';
  problems.push(...checkClassicSw(swSource));
  for (const v of contract.VENDOR_PACKAGES) if (!existsSync(path.join(dist, 'vendor', v.dir, 'LICENSE'))) problems.push(`vendor/${v.dir}/ missing or without LICENSE`);
  const engineHtml = path.join(dist, 'engine', 'index.html');
  if (engineFacade === 'engine/index.html') {
    if (!existsSync(engineHtml)) problems.push('engine/index.html missing');
    else {
      const { scripts, module, placeholder } = engineHtmlScripts(readFileSync(engineHtml, 'utf8'));
      if (JSON.stringify(scripts) !== JSON.stringify(contract.ENGINE_HOST_SCRIPTS)) {
        problems.push(`engine/index.html scripts ${JSON.stringify(scripts)} ≠ ENGINE_HOST_SCRIPTS`);
      }
      if (!module || !/^\/assets\/.+\.js$/.test(module)) problems.push(`engine/index.html module script is ${module}`);
      if (!placeholder) problems.push('engine/index.html lost %GNOME_APP_ORIGINS%');
    }
  }
  // One build id in both bundles: sw.js carries it as a string literal; the engine-host graph must contain it too.
  const buildId = buildIdOf(swSource);
  if (!buildId) problems.push('no build id found in sw.js');
  else {
    const engine = entryChunk(chunks, engineFacade);
    const files = engine ? reachable(chunks, engine).chunks : [];
    const inEngine = files.some((f) => existsSync(path.join(dist, f)) && readFileSync(path.join(dist, f), 'utf8').includes(buildId));
    if (engineFacade === 'engine/index.html' && !inEngine) problems.push(`build id ${buildId} of sw.js is not in the engine-host bundle`);
  }
  return { problems, buildId };
}

export function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
