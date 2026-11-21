// The e2e runner's content-blocker plumbing (docs/WAVE-B3.md §12.1, lane x5): the filter lists the runner's
// gnome-server serves, and how to wait for them.
//
// Test mode (default): the runner writes <runDir>/filter-lists.toml (GNOME_FILTER_LISTS_FILE) that disables every
// built-in filter list, keeps `ubo-resources` (fetched from its upstream; with --offline the pinned copy
// fixtures/blocker/lists/ubo-resources.json as a `file` source) and adds, as `file` lists,
//   - every fixtures/blocker/lists/*.txt (each lane owns its own: network.txt x1, cosmetic.txt and
//     cosmetic-trusted.txt x2, privacy.txt x3), copied into <runDir>/blocker-lists/ so a suite can rewrite a list
//     "on the server" (row S5) without touching the project; each starts with
//       ! gnome-e2e: id=<id> category=<ads|privacy|annoyances|cookies|urlparams|security> trusted=<bool> default=<bool>
//     (optional `name=<text up to the next key or the end>`, `max_mb=<1-64>`);
//   - the generated big list `big` (big.txt: 550,000 distinct `||big-<n>.localhost^` lines, 13.1 MB, default off,
//     max_mb 16), whose engine serializes to more than 16 MiB (rows S4, U11, V10 turn it on). Measured with
//     @ghostery/adblocker 2.20.3 and GNOME's engine configuration: 22,783,521 bytes for this list alone; the
//     400,000 lines WAVE-B3 §12.1 named serialize to 15,586,369 bytes (14.9 MiB), under the 16 MiB they must exceed.
// Real mode (--blocker-real): no TOML, the built-in registry as in production (needs the internet, §12.3); the runner
// asks the server to fetch the lists at once.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_E2E_DIR } from './config.mjs';

export const BLOCKER_FIXTURES_DIR = process.env.E2E_BLOCKER_FIXTURES_DIR || path.join(ENGINE_E2E_DIR, 'fixtures', 'blocker');
/** The lanes' test lists (`*.txt`) and the pinned resources. E2E_BLOCKER_LISTS_DIR overrides it (other list sets). */
export const BLOCKER_LISTS_DIR = process.env.E2E_BLOCKER_LISTS_DIR || path.join(BLOCKER_FIXTURES_DIR, 'lists');
/**
 * Ghostery's `ublock-resources-json` revision 3f95507a…0c64 (2026-11-18; 66 redirect resources, 153 scriptlets, 34 of
 * them `requiresTrust`), byte for byte, so its SHA-256 is that revision. uBlock Origin's resources, GPL-3.0
 * (https://github.com/gorhill/uBlock), as gnome-server's `ubo-resources` entry mirrors them.
 */
export const PINNED_RESOURCES = path.join(ENGINE_E2E_DIR, 'fixtures', 'blocker', 'lists', 'ubo-resources.json');
export const PINNED_RESOURCES_SHA256 = '3f95507a25f41044bb8d1d826b338d9cadfd2256e4e2a02af8097cd3c7720c64';

/**
 * gnome-server's built-in filter lists other than `ubo-resources` (backend/src/filters/registry.rs `builtin()`).
 * Test mode disables each; after the start the runner checks that the server lists nothing else.
 */
export const BUILTIN_LIST_IDS = Object.freeze([
  'easylist',
  'ublock-filters',
  'ublock-badware',
  'ublock-quick-fixes',
  'ublock-unbreak',
  'plowe-0',
  'easyprivacy',
  'ublock-privacy',
  'adguard-spyware-url',
  'fanboy-cookiemonster',
  'ublock-cookies',
  'ublock-annoyances-others',
]);
/** The built-ins on by default (real mode waits for these and the resources). */
export const BUILTIN_DEFAULT_IDS = Object.freeze(BUILTIN_LIST_IDS.slice(0, 9));

/** 550,000 lines: the smallest round count well above 16 MiB once serialized (500,000 give 18.99 MB, 450,000 only 17.29 MB). */
export const BIG_LIST = Object.freeze({ id: 'big', lines: 550_000, maxMb: 16 });

const CATEGORIES = new Set(['ads', 'privacy', 'annoyances', 'cookies', 'urlparams', 'security']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HEADER_RE = /^!\s*gnome-e2e:\s*(.*)$/;

/**
 * The `! gnome-e2e: …` header of a test list (its first non-empty line): {id, category, trusted, default, name, maxMb}.
 * Throws with the file name on anything missing or malformed.
 */
export function parseListHeader(text, file = 'list') {
  const first = text.replace(/^\uFEFF/, '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const m = HEADER_RE.exec(first);
  if (!m) throw new Error(`${file}: the first line must be "! gnome-e2e: id=… category=… trusted=… default=…", got ${JSON.stringify(first.slice(0, 80))}`);
  const fields = {};
  // key=value pairs; `name` runs to the next ` key=` or the end.
  const re = /(\w+)=(.*?)(?=\s+\w+=|$)/g;
  let f;
  while ((f = re.exec(m[1]))) fields[f[1]] = f[2].trim();
  const bool = (k) => {
    if (fields[k] === 'true') return true;
    if (fields[k] === 'false') return false;
    throw new Error(`${file}: ${k}= must be true or false, got ${JSON.stringify(fields[k])}`);
  };
  if (!ID_RE.test(fields.id ?? '')) throw new Error(`${file}: id= must be 1-64 characters of [a-z0-9._-], got ${JSON.stringify(fields.id)}`);
  if (!CATEGORIES.has(fields.category)) throw new Error(`${file}: category= must be one of ${[...CATEGORIES].join(', ')}, got ${JSON.stringify(fields.category)}`);
  let maxMb = null;
  if (fields.max_mb !== undefined) {
    maxMb = Number(fields.max_mb);
    if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 64) throw new Error(`${file}: max_mb= must be 1-64`);
  }
  const name = fields.name && fields.name.length <= 80 ? fields.name : `GNOME e2e ${fields.id}`;
  return { id: fields.id, category: fields.category, trusted: bool('trusted'), default: bool('default'), name, maxMb };
}

/** The generated big list (deterministic: the same bytes, so the same SHA-256, in every run). */
export function bigListText(lines = BIG_LIST.lines) {
  const out = [`! gnome-e2e: id=${BIG_LIST.id} category=ads trusted=false default=false name=GNOME e2e big list`];
  out.push('! Generated by tests/e2e/engine/lib/blocker.mjs: distinct host rules whose engine serializes to > 16 MiB.');
  for (let n = 0; n < lines; n++) out.push(`||big-${n}.localhost^`);
  return `${out.join('\n')}\n`;
}

const tomlString = (s) => JSON.stringify(String(s)); // a TOML basic string: JSON's escapes are valid TOML

/** One `[[list]]` table for a file list. */
function fileListToml(l) {
  return [
    '[[list]]',
    `id = ${tomlString(l.id)}`,
    `name = ${tomlString(l.name)}`,
    `category = ${tomlString(l.category)}`,
    `file = ${tomlString(l.file)}`,
    `license = ${tomlString('CC0-1.0 (GNOME e2e test data)')}`,
    `default_enabled = ${l.default}`,
    `trusted = ${l.trusted}`,
    ...(l.maxMb ? [`max_mb = ${l.maxMb}`] : []),
    '',
  ].join('\n');
}

/**
 * Prepares the lists of a run. mode 'test' (default) or 'real'; offline: the pinned resources instead of upstream.
 * Returns {mode, offline, toml (path or null), dir, lists: [{id, name, category, trusted, default, maxMb, file,
 * source}], resources: 'upstream' | 'file', expect: the ids the server must list}.
 */
export function prepareBlockerLists({ runDir, mode = 'test', offline = false, listsDir = BLOCKER_LISTS_DIR }) {
  if (mode === 'real') {
    if (offline) throw new Error('--blocker-real needs the internet: it cannot run with --offline');
    return { mode, offline, toml: null, dir: null, lists: [], resources: 'upstream', expect: [...BUILTIN_LIST_IDS, 'ubo-resources'] };
  }
  if (mode !== 'test') throw new Error(`unknown blocker list mode ${mode}`);
  const dir = path.join(runDir, 'blocker-lists');
  fs.mkdirSync(dir, { recursive: true });
  const lists = [];
  const names = fs.existsSync(listsDir) ? fs.readdirSync(listsDir).filter((f) => f.endsWith('.txt')).sort() : [];
  for (const name of names) {
    const src = path.join(listsDir, name);
    const text = fs.readFileSync(src, 'utf8');
    const h = parseListHeader(text, path.relative(ENGINE_E2E_DIR, src));
    if (h.id === BIG_LIST.id || h.id === 'ubo-resources' || BUILTIN_LIST_IDS.includes(h.id)) throw new Error(`${name}: id=${h.id} is reserved`);
    if (lists.some((l) => l.id === h.id)) throw new Error(`${name}: id=${h.id} appears twice`);
    const file = path.join(dir, name);
    fs.copyFileSync(src, file);
    lists.push({ ...h, file, source: src });
  }
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, bigListText());
  lists.push({ ...parseListHeader(bigListText(1), 'big.txt'), maxMb: BIG_LIST.maxMb, file: big, source: null });
  const parts = [
    '# Written by tests/e2e/engine/lib/blocker.mjs for one e2e run (GNOME_FILTER_LISTS_FILE). Test data only.',
    '# Every built-in list is off; the lanes\' test lists and the generated big list are read from files.',
    '',
    ...BUILTIN_LIST_IDS.flatMap((id) => ['[[list]]', `id = ${tomlString(id)}`, 'disabled = true', '']),
  ];
  if (offline) parts.push('[[list]]', 'id = "ubo-resources"', `file = ${tomlString(PINNED_RESOURCES)}`, '');
  for (const l of lists) parts.push(fileListToml(l));
  const toml = path.join(runDir, 'filter-lists.toml');
  fs.writeFileSync(toml, parts.join('\n'));
  return { mode, offline, toml, dir, lists, resources: offline ? 'file' : 'upstream', expect: [...lists.map((l) => l.id), 'ubo-resources'] };
}

/**
 * Removes a run's copies of the generated big list after the run: the run copy (`<listsDir>/big.txt`) and the server's
 * stored versions (`<dataDir>/filters/big.<sha256>.txt` with its `.br` and `.gz`), ~28 MB of every run directory that
 * bigListText() gives again byte for byte. Call it only once the server has stopped. Returns the removed paths.
 */
export function removeBigListCopies({ listsDir, dataDir }) {
  const gone = [];
  const rm = (f) => {
    try {
      if (fs.existsSync(f)) {
        fs.rmSync(f, { force: true });
        gone.push(f);
      }
    } catch {
      /* best effort */
    }
  };
  if (listsDir) rm(path.join(listsDir, 'big.txt'));
  const stored = path.join(dataDir, 'filters');
  if (fs.existsSync(stored)) {
    for (const n of fs.readdirSync(stored)) if (/^big\.[0-9a-f]{64}\.txt(\.br|\.gz)?$/.test(n)) rm(path.join(stored, n));
  }
  return gone;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `GET /api/filters` → {lists, resources} (null while the server is not answering). */
export async function fetchListing(origin) {
  try {
    const r = await fetch(`${origin}/api/filters`, { headers: { 'Cache-Control': 'no-cache' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Asks the server to check every list now (`POST /admin/filters/refresh`; answered 202, runs in the background). */
export async function requestRefresh(adminOrigin) {
  const r = await fetch(`${adminOrigin}/admin/filters/refresh`, { method: 'POST', headers: { 'X-GNOME-Request': '1' } });
  if (r.status !== 202) throw new Error(`POST /admin/filters/refresh answered ${r.status}`);
}

/**
 * Waits until every id of `expect` is listed and available (or `timeoutMs` passed). `refresh`: ask the server to
 * fetch upstream first (resources from upstream, real mode; GNOME_FILTERS_REFRESH_HOURS is 0 in e2e runs).
 * Returns {ok, ms, listing, missing (not listed), unavailable, unexpected (listed but not expected)}.
 */
export async function waitForLists({ appOrigin, adminOrigin, expect, refresh = false, timeoutMs = 120_000 }) {
  const t0 = Date.now();
  if (refresh) await requestRefresh(adminOrigin);
  let listing = null;
  let state = { missing: expect, unavailable: [], unexpected: [] };
  while (Date.now() - t0 < timeoutMs) {
    listing = await fetchListing(appOrigin);
    if (listing) {
      const all = [...(listing.lists ?? []), ...(listing.resources ? [listing.resources] : [])];
      const ids = all.map((l) => l.id);
      state = {
        missing: expect.filter((id) => !ids.includes(id)),
        unavailable: all.filter((l) => expect.includes(l.id) && !l.available).map((l) => l.id),
        unexpected: ids.filter((id) => !expect.includes(id)),
      };
      if (!state.missing.length && !state.unavailable.length) return { ok: true, ms: Date.now() - t0, listing, ...state };
      if (state.missing.length) break; // the registry is fixed at start: a missing id never appears
    }
    await sleep(250);
  }
  return { ok: false, ms: Date.now() - t0, listing, ...state };
}
