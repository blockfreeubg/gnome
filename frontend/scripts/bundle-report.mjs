#!/usr/bin/env node
// @ts-nocheck -- plain Node script (no JSDoc types); its behaviour is covered by the Vitest tests next to it.
/**
 * bundle-report (WAVE-D §4.1): the startup sets of `index.html` and `engine/index.html` (the files each page loads at
 * start: `<script src>`, `<link rel=modulepreload>`, `<link rel=stylesheet>`; vendor files listed apart) with raw,
 * gzip -9 and brotli 11 sizes, and every lazy chunk with its modules from `.vite/gnome-chunks.json`.
 * Same definition as the UI gate's size measurement: per-file gzip level 9, KB = 1000 B.
 *
 *   node frontend/scripts/bundle-report.mjs [--dist DIR] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultDist() {
  return process.env.GNOME_DIST_DIR ? path.resolve(process.env.GNOME_DIST_DIR) : path.join(FRONTEND, 'dist');
}

export function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

export function brotliSize(buf) {
  return zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
}

/** The same-origin URLs a page loads at start, in document order (no duplicates). */
export function startupUrls(html) {
  const urls = [];
  const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? null;
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    let url = null;
    if (m[1].toLowerCase() === 'script') url = attr(tag, 'src');
    else {
      const rel = (attr(tag, 'rel') ?? '').toLowerCase();
      if (rel === 'modulepreload' || rel === 'stylesheet') url = attr(tag, 'href');
    }
    if (url && url.startsWith('/') && !url.startsWith('//') && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function measure(dist, url) {
  const file = path.join(dist, url.split('?')[0]);
  const buf = fs.readFileSync(file);
  return { url, raw: buf.length, gzip: gzipSize(buf), br: brotliSize(buf) };
}

function sum(files, ext) {
  const sel = files.filter((f) => !ext || f.url.endsWith(ext));
  return {
    files: sel.length,
    raw: sel.reduce((a, f) => a + f.raw, 0),
    gzip: sel.reduce((a, f) => a + f.gzip, 0),
    br: sel.reduce((a, f) => a + f.br, 0),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Startup sets of both pages, lazy chunks and module lists. */
export function report(dist = defaultDist()) {
  const pages = {};
  const startup = new Set();
  for (const [name, html] of [['app', 'index.html'], ['engine', 'engine/index.html']]) {
    const file = path.join(dist, html);
    if (!fs.existsSync(file)) continue;
    const urls = startupUrls(fs.readFileSync(file, 'utf8'));
    const own = [];
    const vendor = [];
    for (const u of urls) {
      startup.add(u.slice(1));
      (u.startsWith('/vendor/') ? vendor : own).push(measure(dist, u));
    }
    pages[name] = { own, vendor, total: sum(own), js: sum(own, '.js'), css: sum(own, '.css'), vendorTotal: sum(vendor) };
  }
  const graph = readJson(path.join(dist, '.vite/gnome-chunks.json')) ?? {};
  const lazy = [];
  for (const [file, c] of Object.entries(graph)) {
    if (startup.has(file) || !fs.existsSync(path.join(dist, file))) continue;
    lazy.push({ ...measure(dist, `/${file}`), name: c.name, modules: (c.modules ?? []).length });
  }
  lazy.sort((a, b) => b.gzip - a.gzip);
  return { dist, pages, lazy };
}

const kb = (n) => `${(n / 1000).toFixed(1)} KB`;

function print(r) {
  for (const [name, p] of Object.entries(r.pages)) {
    console.log(`\n${name} startup set (GNOME's files): ${p.total.files} files, ${kb(p.total.raw)} raw, ${kb(p.total.gzip)} gzip, ${kb(p.total.br)} brotli`);
    console.log(`  JS ${kb(p.js.gzip)} gzip (${p.js.files} files) · CSS ${kb(p.css.gzip)} gzip (${p.css.files} files)`);
    for (const f of p.own) console.log(`  ${kb(f.gzip).padStart(10)}  ${f.url}`);
    if (p.vendor.length) {
      console.log(`  vendor (unmodified upstream): ${kb(p.vendorTotal.gzip)} gzip`);
      for (const f of p.vendor) console.log(`  ${kb(f.gzip).padStart(10)}  ${f.url}`);
    }
  }
  console.log(`\nlazy chunks: ${r.lazy.length}`);
  for (const c of r.lazy) console.log(`  ${kb(c.gzip).padStart(10)}  ${c.url} (${c.modules} modules)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--dist');
  const dist = i >= 0 ? path.resolve(args[i + 1]) : defaultDist();
  const r = report(dist);
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else print(r);
}
