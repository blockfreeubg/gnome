/**
 * Third-party components GNOME ships, with their licenses (About → Open-source licenses).
 *
 * This is the one place to maintain the list. Every entry was checked against the shipped files, not only the
 * package metadata, and `licenses.test.ts` cross-checks versions and names against frontend/package.json,
 * tests/e2e/package.json (the pinned engine builds), services/holywisp/VERSION, Cargo.toml and Cargo.lock.
 *
 * Sources: frontend/node_modules (Svelte, Lucide, fonts), tests/e2e/node_modules (engines and transports: package.json
 * plus the LICENSE file each tarball ships and the source maps of the files GNOME serves), services/holywisp (LICENSE,
 * licenses/musl-*.COPYRIGHT), docs/research/*.md (Scramjet and Ultraviolet license history, the content-blocking
 * engine and filter lists).
 *
 * When adding or upgrading a dependency:
 *  - npm: update `version`, re-read the package's LICENSE file (package.json "license" fields have been wrong before:
 *    Ultraviolet says MIT but ships the AGPL-3.0 text) and list what its served bundle includes.
 *  - Rust: regenerate RUST_CRATES with `node scripts/rust-crates.mjs` (from cargo tree; `--check` only compares).
 *    licenses.test.ts runs the comparison whenever cargo is available, so a new or upgraded crate fails the tests.
 *  - Use license keys from LICENSES (SPDX ids where one exists); the tests reject unknown keys.
 */

import type { Feature } from '../../settings/features';

export interface LicenseInfo {
  /** Display name. */
  name: string;
  /** Canonical license text. */
  url: string;
}

/** License (and exception) ids used below → display name and text. */
export const LICENSES = {
  'AGPL-3.0-only': { name: 'GNU AGPL v3.0 only', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
  'AGPL-3.0': { name: 'GNU AGPL v3.0', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
  'GPL-3.0': { name: 'GNU GPL v3.0', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
  'GPL-3.0-or-later': { name: 'GNU GPL v3.0 or later', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
  'LGPL-3.0-or-later': { name: 'GNU LGPL v3.0 or later', url: 'https://www.gnu.org/licenses/lgpl-3.0.html' },
  'MPL-2.0': { name: 'Mozilla Public License 2.0', url: 'https://www.mozilla.org/en-US/MPL/2.0/' },
  MIT: { name: 'MIT License', url: 'https://opensource.org/license/mit' },
  ISC: { name: 'ISC License', url: 'https://opensource.org/license/isc-license-txt' },
  '0BSD': { name: 'BSD Zero Clause License', url: 'https://opensource.org/license/0bsd' },
  'BSD-2-Clause': { name: 'BSD 2-Clause License', url: 'https://opensource.org/license/bsd-2-clause' },
  'BSD-3-Clause': { name: 'BSD 3-Clause License', url: 'https://opensource.org/license/bsd-3-clause' },
  'Apache-2.0': { name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  'LLVM-exception': { name: 'LLVM exception', url: 'https://spdx.org/licenses/LLVM-exception.html' },
  'BSL-1.0': { name: 'Boost Software License 1.0', url: 'https://www.boost.org/LICENSE_1_0.txt' },
  'Unicode-3.0': { name: 'Unicode License v3', url: 'https://www.unicode.org/license.txt' },
  Unlicense: { name: 'The Unlicense', url: 'https://unlicense.org/' },
  Zlib: { name: 'zlib License', url: 'https://www.zlib.net/zlib_license.html' },
  curl: { name: 'curl License', url: 'https://curl.se/docs/copyright.html' },
  'OFL-1.1': { name: 'SIL Open Font License 1.1', url: 'https://openfontlicense.org/' },
  'CDLA-Permissive-2.0': { name: 'Community Data License Agreement – Permissive 2.0', url: 'https://cdla.dev/permissive-2-0/' },
  'CC-BY-3.0': { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/' },
  'CC-BY-SA-3.0': { name: 'CC BY-SA 3.0 or later', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
  'LicenseRef-public-domain': { name: 'Public domain', url: 'https://sqlite.org/copyright.html' },
  'LicenseRef-public-data': { name: 'Public data', url: 'https://www.iana.org/domains/root/files' },
  'LicenseRef-no-license': { name: 'No formal license', url: 'https://pgl.yoyo.org/adservers/' },
} as const satisfies Record<string, LicenseInfo>;

export type LicenseKey = keyof typeof LICENSES;

/** Code bundled inside a component's shipped files (credited with it). */
export interface Bundled {
  name: string;
  /** License expression made of LICENSES keys. */
  license: string;
  url?: string;
}

export interface Component {
  /** Stable id (tests and keyed lists). */
  id: string;
  name: string;
  /** Pinned version or commit; omitted when the item is not versioned. */
  version?: string;
  /** SPDX-style expression made of LICENSES keys: "MIT", "MIT OR Apache-2.0", "Apache-2.0 WITH LLVM-exception". */
  license: string;
  /** Project home or source repository. */
  url: string;
  /** Copyright notice, verbatim from the component's license file. */
  copyright?: string;
  /** Author or publisher as the project names itself (shown when there is no verbatim notice). */
  author?: string;
  /** One or two plain sentences: what it does in GNOME and anything unusual about its license. */
  note?: string;
  includes?: readonly Bundled[];
}

export interface ComponentGroup {
  id: string;
  title: string;
  description: string;
  /** Shipped only with this feature (settings/features.ts); the group is listed once the feature is present. */
  needs?: Feature;
  components: readonly Component[];
}

export interface RustCrate {
  name: string;
  version: string;
  license: string;
}

const LIBCURL_JS_LIBS: readonly Bundled[] = [
  { name: 'libcurl.js', license: 'LGPL-3.0-or-later', url: 'https://github.com/ading2210/libcurl.js' },
  { name: 'libcurl', license: 'curl', url: 'https://curl.se/libcurl/' },
  { name: 'Mbed TLS', license: 'Apache-2.0', url: 'https://github.com/Mbed-TLS/mbedtls' },
  { name: 'cJSON', license: 'MIT', url: 'https://github.com/DaveGamble/cJSON' },
  { name: 'zlib', license: 'Zlib', url: 'https://www.zlib.net/' },
  { name: 'Brotli', license: 'MIT', url: 'https://github.com/google/brotli' },
  { name: 'nghttp2', license: 'MIT', url: 'https://github.com/nghttp2/nghttp2' },
];

/** GNOME itself (also the license the AGPL source offer refers to). */
export const GNOME_LICENSE: LicenseKey = 'AGPL-3.0-only';

export const COMPONENT_GROUPS: readonly ComponentGroup[] = [
  {
    id: 'engines',
    title: 'Proxy engines and transports',
    needs: 'browser',
    description:
      'Served unmodified from the proxy origin and run in your browser. Most of them are under the GNU AGPL v3.0, which is why GNOME offers its own source to everyone who uses it.',
    components: [
      {
        id: 'scramjet',
        name: 'Scramjet',
        version: '2.0.67-alpha.2',
        license: 'AGPL-3.0-only',
        url: 'https://github.com/MercuryWorkshop/scramjet',
        author: 'Mercury Workshop',
        note: 'Primary proxy engine (scramjet.js and its WebAssembly rewriter). The package ships no LICENSE file; its metadata and the project repository state AGPL-3.0-only.',
        includes: [
          { name: 'htmlparser2', license: 'MIT', url: 'https://github.com/fb55/htmlparser2' },
          { name: 'domhandler', license: 'BSD-2-Clause', url: 'https://github.com/fb55/domhandler' },
          { name: 'dom-serializer', license: 'MIT', url: 'https://github.com/cheeriojs/dom-serializer' },
          { name: 'domelementtype', license: 'BSD-2-Clause', url: 'https://github.com/fb55/domelementtype' },
          { name: 'entities', license: 'BSD-2-Clause', url: 'https://github.com/fb55/entities' },
          { name: 'proxy-transports', license: 'MIT', url: 'https://github.com/MercuryWorkshop/proxy-transports' },
        ],
      },
      {
        id: 'scramjet-controller',
        name: 'Scramjet controller',
        version: '0.0.14',
        license: 'AGPL-3.0-only',
        url: 'https://github.com/MercuryWorkshop/scramjet',
        author: 'Mercury Workshop',
        note: 'Connects Scramjet to the service worker and the transports.',
        includes: [
          { name: '@fastify/deepmerge', license: 'MIT', url: 'https://github.com/fastify/deepmerge' },
          { name: 'proxy-transports', license: 'MIT', url: 'https://github.com/MercuryWorkshop/proxy-transports' },
        ],
      },
      {
        id: 'ultraviolet',
        name: 'Ultraviolet',
        version: '3.2.10',
        license: 'AGPL-3.0',
        url: 'https://github.com/titaniumnetwork-dev/Ultraviolet',
        author: 'Titanium Network',
        note: 'Fallback proxy engine. Its package.json says MIT, but the LICENSE file it ships is the GNU AGPL v3.0 text; GNOME follows the license file.',
        includes: [
          { name: 'meriyah', license: 'ISC', url: 'https://github.com/meriyah/meriyah' },
          { name: 'astring', license: 'MIT', url: 'https://github.com/davidbonnet/astring' },
          { name: 'parse5', license: 'MIT', url: 'https://github.com/inikulin/parse5' },
          { name: 'entities', license: 'BSD-2-Clause', url: 'https://github.com/fb55/entities' },
          { name: 'set-cookie-parser', license: 'MIT', url: 'https://github.com/nfriedly/set-cookie-parser' },
          { name: 'idb', license: 'ISC', url: 'https://github.com/jakearchibald/idb' },
          { name: 'events', license: 'MIT', url: 'https://github.com/browserify/events' },
          { name: 'bare-mux', license: 'MIT', url: 'https://github.com/MercuryWorkshop/bare-mux' },
        ],
      },
      {
        id: 'bare-mux',
        name: 'bare-mux',
        version: '2.1.9',
        license: 'MIT',
        url: 'https://github.com/MercuryWorkshop/bare-mux',
        copyright: 'Copyright 2024 Mercury Workshop Inc.',
        note: 'Shares one transport between Ultraviolet tabs. Its package.json declares no license; the LICENSE file is MIT.',
      },
      {
        id: 'libcurl-transport',
        name: 'libcurl transport',
        version: '2.0.6 (Scramjet) · 1.5.2 (Ultraviolet)',
        license: 'AGPL-3.0-only',
        url: 'https://github.com/MercuryWorkshop/libcurl-transport',
        author: 'ading2210 and Mercury Workshop',
        note: 'Default Wisp transport: TLS to the sites you visit is negotiated inside your browser by curl compiled to WebAssembly.',
        includes: LIBCURL_JS_LIBS,
      },
      {
        id: 'epoxy-transport',
        name: 'Epoxy transport',
        version: '3.0.2 (Scramjet) · 2.1.29 (Ultraviolet)',
        license: 'AGPL-3.0-only',
        url: 'https://github.com/MercuryWorkshop/epoxy-transport',
        author: 'Mercury Workshop',
        note: 'Alternative Wisp transport with TLS in WebAssembly.',
        includes: [{ name: 'epoxy-tls', license: 'AGPL-3.0-only', url: 'https://github.com/MercuryWorkshop/epoxy-tls' }],
      },
      {
        id: 'proxy-transports',
        name: 'proxy-transports',
        version: '1.0.2',
        license: 'MIT',
        url: 'https://github.com/MercuryWorkshop/proxy-transports',
        author: 'Mercury Workshop',
        note: 'Transport interface shared by Scramjet and its transports.',
      },
    ],
  },
  {
    id: 'blocking',
    title: 'Content blocking',
    needs: 'extensions',
    description: 'The filter engine behind the built-in ad and tracker blockers.',
    components: [
      {
        id: 'ghostery-adblocker',
        name: 'Ghostery adblocker',
        version: '2.20.3',
        license: 'MPL-2.0',
        url: 'https://github.com/ghostery/adblocker',
        copyright: 'Copyright (c) 2017-present Ghostery GmbH. All rights reserved.',
        note: 'Matches requests and page elements against the filter lists below. Bundled unmodified into GNOME’s browser-engine code; its source is at the link.',
        includes: [
          { name: '@ghostery/adblocker-content 2.20.3', license: 'MPL-2.0', url: 'https://github.com/ghostery/adblocker' },
          { name: '@ghostery/adblocker-extended-selectors 2.20.3', license: 'MPL-2.0', url: 'https://github.com/ghostery/adblocker' },
          { name: '@ghostery/url-parser 1.3.1', license: 'MPL-2.0', url: 'https://github.com/ghostery/url-parser' },
          { name: '@remusao/guess-url-type, small, smaz, trie', license: 'MPL-2.0', url: 'https://github.com/remusao/mono' },
        ],
      },
      {
        id: 'tldts',
        name: 'tldts',
        version: '7.4.19',
        license: 'MIT',
        url: 'https://github.com/remusao/tldts',
        copyright: 'Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson',
        note: 'Public Suffix List lookups (tldts-experimental and tldts-core): which site a page belongs to, for the filter engine, the shield’s “Pause on this site” and the cookie list.',
      },
    ],
  },
  {
    id: 'filter-lists',
    title: 'Filter lists',
    description:
      'Fetched by the GNOME server from their publishers and passed on to your browser unchanged. Each list keeps its own license and attribution.',
    components: [
      {
        id: 'easylist',
        name: 'EasyList',
        license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
        url: 'https://easylist.to/',
        author: 'The EasyList authors',
      },
      {
        id: 'easyprivacy',
        name: 'EasyPrivacy',
        license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
        url: 'https://easylist.to/',
        author: 'The EasyList authors',
      },
      {
        id: 'ublock-filters',
        name: 'uBlock filters (ads, badware risks, privacy, quick fixes, unbreak, cookie notices, other annoyances)',
        license: 'GPL-3.0',
        url: 'https://github.com/uBlockOrigin/uAssets',
        author: 'The uBlock Origin authors',
      },
      {
        id: 'ublock-resources',
        name: 'uBlock Origin redirect resources and scriptlets',
        license: 'GPL-3.0',
        url: 'https://github.com/gorhill/uBlock',
        author: 'Raymond Hill (gorhill) and contributors',
        note: 'Neutral stand-ins for blocked scripts, as packaged by the Ghostery adblocker project.',
      },
      {
        id: 'adguard-url-tracking',
        name: 'AdGuard URL Tracking Protection (uBlock Origin edition)',
        license: 'GPL-3.0',
        url: 'https://github.com/AdguardTeam/AdguardFilters',
        author: 'AdGuard',
        note: 'Removes tracking parameters from links.',
      },
      {
        id: 'peter-lowe',
        name: 'Peter Lowe’s ad and tracking server list',
        license: 'LicenseRef-no-license',
        url: 'https://pgl.yoyo.org/adservers/',
        author: 'Peter Lowe',
        note: 'Published without a formal license; the author invites combining it with other lists and republishing it.',
      },
      {
        id: 'fanboy-cookiemonster',
        name: 'EasyList Cookie List (Fanboy’s Cookiemonster)',
        license: 'CC-BY-3.0',
        url: 'https://secure.fanboy.co.nz/',
        author: 'Fanboy and the EasyList authors',
        note: 'The list header says CC BY 3.0; the uBlock Origin mirror points to the EasyList license instead.',
      },
    ],
  },
  {
    id: 'interface',
    title: 'Interface',
    description: 'Part of the GNOME web app itself.',
    components: [
      {
        id: 'svelte',
        name: 'Svelte',
        version: '5.57.3',
        license: 'MIT',
        url: 'https://github.com/sveltejs/svelte',
        copyright: 'Copyright (c) 2016-2025 Svelte Contributors',
        note: 'UI framework (its runtime is compiled into the app).',
        includes: [
          { name: 'clsx', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
          { name: 'esm-env', license: 'MIT', url: 'https://github.com/benmccann/esm-env' },
        ],
      },
      {
        id: 'lucide',
        name: 'Lucide icons',
        version: '1.70.0',
        license: 'ISC',
        url: 'https://lucide.dev/',
        copyright: 'Copyright (c) 2026 Lucide Icons and Contributors',
        note: 'Every icon in the interface (@lucide/svelte). Icons that Lucide derived from Feather, such as the chevrons, check mark and close icon, are under Feather’s MIT license (Copyright (c) 2013-present Cole Bemis).',
        includes: [{ name: 'Feather icons', license: 'MIT', url: 'https://github.com/feathericons/feather' }],
      },
      {
        id: 'font-inter',
        name: 'Inter',
        version: '5.3.0',
        license: 'OFL-1.1',
        url: 'https://github.com/rsms/inter',
        copyright: 'Copyright 2016 The Inter Project Authors',
        note: 'Interface typeface (packaged by Fontsource).',
      },
      {
        id: 'font-montserrat',
        name: 'Montserrat',
        version: '5.3.0',
        license: 'OFL-1.1',
        url: 'https://github.com/JulietaUla/Montserrat',
        copyright: 'Copyright 2011 The Montserrat Project Authors',
        note: 'Display typeface for the wordmark and headings, also an optional interface typeface (packaged by Fontsource).',
      },
      {
        id: 'font-geist',
        name: 'Geist and Geist Mono',
        version: '5.3.0',
        license: 'OFL-1.1',
        url: 'https://github.com/vercel/geist-font',
        copyright: 'Copyright 2024 The Geist Project Authors',
        note: 'Monospace typeface, and Geist as an optional interface typeface (packaged by Fontsource).',
      },
      {
        id: 'font-fraunces',
        name: 'Fraunces',
        version: '5.3.0',
        license: 'OFL-1.1',
        url: 'https://github.com/undercasetype/Fraunces',
        copyright: 'Copyright 2020 The Fraunces Project Authors',
        note: 'Optional serif interface typeface (packaged by Fontsource).',
      },
      {
        id: 'font-atkinson',
        name: 'Atkinson Hyperlegible Next',
        version: '5.3.0',
        license: 'OFL-1.1',
        url: 'https://github.com/googlefonts/atkinson-hyperlegible-next',
        copyright: 'Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors',
        note: 'Optional interface typeface (packaged by Fontsource).',
      },
      {
        id: 'iana-tlds',
        name: 'IANA list of top-level domains',
        version: '2026110900',
        license: 'LicenseRef-public-data',
        url: 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt',
        author: 'Internet Assigned Numbers Authority',
        note: 'Tells web addresses from searches in what you type.',
      },
    ],
  },
  {
    id: 'server',
    title: 'Server',
    description: 'Runs on the machine that hosts this GNOME instance.',
    components: [
      {
        id: 'holywisp',
        name: 'HolyWisp',
        version: 'e0a0f15',
        license: 'ISC',
        url: 'https://github.com/Fracital/holyWisp',
        copyright: 'Copyright (c) 2026 David Reed',
        note: 'The Wisp server that relays encrypted connections to the sites you visit. Its README says MIT; the LICENSE file is ISC and is the one that applies.',
      },
      {
        id: 'musl',
        name: 'musl libc',
        version: '1.2.5',
        license: 'MIT',
        url: 'https://musl.libc.org/',
        copyright: 'Copyright © 2005-2020 Rich Felker, et al.',
        note: 'Statically linked into the HolyWisp binaries.',
      },
      {
        id: 'sqlite',
        name: 'SQLite',
        version: '3.54.1',
        license: 'LicenseRef-public-domain',
        url: 'https://sqlite.org/',
        note: 'Embedded database for accounts, synced data and the games catalog (compiled in by rusqlite).',
      },
      {
        id: 'rust-std',
        name: 'Rust standard library',
        license: 'MIT OR Apache-2.0',
        url: 'https://github.com/rust-lang/rust',
        author: 'The Rust Project Developers',
        note: 'Compiled into gnome-server, together with the crates listed below.',
      },
    ],
  },
];

/**
 * Rust crates compiled into (or used to build) gnome-server: the normal dependency graph of the server and its
 * workspace crates (gnome-net, gnome-catalog) on Linux. Test-only crates are not shipped and not listed.
 */
export const RUST_CRATES: readonly RustCrate[] = (
  [
    // BEGIN RUST_CRATES (generated by scripts/rust-crates.mjs; do not edit by hand)
    ['adler2', '2.0.1', '0BSD OR MIT OR Apache-2.0'],
    ['alloc-no-stdlib', '3.0.0', 'BSD-3-Clause'],
    ['alloc-stdlib', '0.3.0', 'BSD-3-Clause'],
    ['anstyle', '1.0.14', 'MIT OR Apache-2.0'],
    ['argon2', '0.6.0', 'MIT OR Apache-2.0'],
    ['async-compression', '0.4.52', 'MIT OR Apache-2.0'],
    ['atomic-waker', '1.1.2', 'Apache-2.0 OR MIT'],
    ['axum', '0.8.9', 'MIT'],
    ['axum-core', '0.5.6', 'MIT'],
    ['base64', '0.23.1', 'MIT OR Apache-2.0'],
    ['base64ct', '1.8.3', 'Apache-2.0 OR MIT'],
    ['bitflags', '2.13.2', 'MIT OR Apache-2.0'],
    ['blake2', '0.11.0', 'MIT OR Apache-2.0'],
    ['block-buffer', '0.12.1', 'MIT OR Apache-2.0'],
    ['brotli', '9.1.1', 'BSD-3-Clause AND MIT'],
    ['brotli-decompressor', '6.3.1', 'BSD-3-Clause OR MIT'],
    ['bytes', '1.12.1', 'MIT'],
    ['cfg-if', '1.0.5', 'MIT OR Apache-2.0'],
    ['clap', '4.6.7', 'MIT OR Apache-2.0'],
    ['clap_builder', '4.6.7', 'MIT OR Apache-2.0'],
    ['clap_derive', '4.6.7', 'MIT OR Apache-2.0'],
    ['clap_lex', '1.1.1', 'MIT OR Apache-2.0'],
    ['cmov', '0.5.4', 'Apache-2.0 OR MIT'],
    ['compression-codecs', '0.4.47', 'MIT OR Apache-2.0'],
    ['compression-core', '0.4.34', 'MIT OR Apache-2.0'],
    ['cpufeatures', '0.3.1', 'MIT OR Apache-2.0'],
    ['crc32fast', '1.5.5', 'MIT OR Apache-2.0'],
    ['crypto-common', '0.2.2', 'MIT OR Apache-2.0'],
    ['ctutils', '0.4.8', 'Apache-2.0 OR MIT'],
    ['digest', '0.11.3', 'MIT OR Apache-2.0'],
    ['displaydoc', '0.2.7', 'MIT OR Apache-2.0'],
    ['errno', '0.3.14', 'MIT OR Apache-2.0'],
    ['fallible-iterator', '0.3.0', 'MIT OR Apache-2.0'],
    ['fallible-streaming-iterator', '0.1.9', 'MIT OR Apache-2.0'],
    ['flate2', '1.1.11', 'MIT OR Apache-2.0'],
    ['foldhash', '0.2.0', 'Zlib'],
    ['form_urlencoded', '1.2.2', 'MIT OR Apache-2.0'],
    ['futures-channel', '0.3.34', 'MIT OR Apache-2.0'],
    ['futures-core', '0.3.34', 'MIT OR Apache-2.0'],
    ['futures-macro', '0.3.34', 'MIT OR Apache-2.0'],
    ['futures-sink', '0.3.34', 'MIT OR Apache-2.0'],
    ['futures-task', '0.3.34', 'MIT OR Apache-2.0'],
    ['futures-util', '0.3.34', 'MIT OR Apache-2.0'],
    ['getrandom', '0.2.17', 'MIT OR Apache-2.0'],
    ['getrandom', '0.4.3', 'MIT OR Apache-2.0'],
    ['hashbrown', '0.17.1', 'MIT OR Apache-2.0'],
    ['hashlink', '0.12.2', 'MIT OR Apache-2.0'],
    ['heck', '0.5.0', 'MIT OR Apache-2.0'],
    ['hmac', '0.13.0', 'MIT OR Apache-2.0'],
    ['http', '1.5.0', 'MIT OR Apache-2.0'],
    ['http-body', '1.1.0', 'MIT'],
    ['http-body-util', '0.1.5', 'MIT'],
    ['httparse', '1.10.1', 'MIT OR Apache-2.0'],
    ['httpdate', '1.0.3', 'MIT OR Apache-2.0'],
    ['hybrid-array', '0.4.15', 'MIT OR Apache-2.0'],
    ['hyper', '1.12.0', 'MIT'],
    ['hyper-rustls', '0.27.10', 'Apache-2.0 OR ISC OR MIT'],
    ['hyper-util', '0.1.21', 'MIT'],
    ['icu_collections', '2.4.0', 'Unicode-3.0'],
    ['icu_locale_core', '2.4.0', 'Unicode-3.0'],
    ['icu_normalizer', '2.4.0', 'Unicode-3.0'],
    ['icu_normalizer_data', '2.4.0', 'Unicode-3.0'],
    ['icu_properties', '2.4.0', 'Unicode-3.0'],
    ['icu_properties_data', '2.4.0', 'Unicode-3.0'],
    ['icu_provider', '2.4.0', 'Unicode-3.0'],
    ['idna', '1.1.0', 'MIT OR Apache-2.0'],
    ['idna_adapter', '1.2.2', 'Apache-2.0 OR MIT'],
    ['ipnet', '2.12.2', 'MIT OR Apache-2.0'],
    ['itoa', '1.0.19', 'MIT OR Apache-2.0'],
    ['lazy_static', '1.5.1', 'MIT OR Apache-2.0'],
    ['libc', '0.2.191', 'MIT OR Apache-2.0'],
    ['libsqlite3-sys', '0.39.1', 'MIT'],
    ['linux-raw-sys', '0.12.1', 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'],
    ['litemap', '0.8.3', 'Unicode-3.0'],
    ['log', '0.4.35', 'MIT OR Apache-2.0'],
    ['matchers', '0.2.0', 'MIT'],
    ['matchit', '0.8.4', 'MIT AND BSD-3-Clause'],
    ['memchr', '2.8.3', 'Unlicense OR MIT'],
    ['mime', '0.3.18', 'MIT OR Apache-2.0'],
    ['miniz_oxide', '0.9.1', 'MIT OR Zlib OR Apache-2.0'],
    ['mio', '1.2.4', 'MIT'],
    ['nu-ansi-term', '0.50.3', 'MIT'],
    ['once_cell', '1.21.4', 'MIT OR Apache-2.0'],
    ['openssl-probe', '0.2.2', 'MIT OR Apache-2.0'],
    ['password-hash', '0.6.1', 'MIT OR Apache-2.0'],
    ['percent-encoding', '2.3.2', 'MIT OR Apache-2.0'],
    ['phc', '0.6.1', 'Apache-2.0 OR MIT'],
    ['pin-project-lite', '0.2.17', 'Apache-2.0 OR MIT'],
    ['potential_utf', '0.1.6', 'Unicode-3.0'],
    ['proc-macro2', '1.0.107', 'MIT OR Apache-2.0'],
    ['quick-xml', '0.42.0', 'MIT'],
    ['quote', '1.0.47', 'MIT OR Apache-2.0'],
    ['regex-automata', '0.4.18', 'MIT OR Apache-2.0'],
    ['regex-syntax', '0.8.11', 'MIT OR Apache-2.0'],
    ['reqwest', '0.13.5', 'MIT OR Apache-2.0'],
    ['ring', '0.17.14', 'Apache-2.0 AND ISC'],
    ['rpassword', '7.5.4', 'Apache-2.0'],
    ['rtoolbox', '0.0.6', 'Apache-2.0'],
    ['rusqlite', '0.41.1', 'MIT'],
    ['rustix', '1.1.6', 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'],
    ['rustls', '0.23.46', 'Apache-2.0 OR ISC OR MIT'],
    ['rustls-native-certs', '0.8.5', 'Apache-2.0 OR ISC OR MIT'],
    ['rustls-pki-types', '1.16.0', 'MIT OR Apache-2.0'],
    ['rustls-platform-verifier', '0.7.1', 'MIT OR Apache-2.0'],
    ['rustls-webpki', '0.103.16', 'ISC'],
    ['ryu', '1.0.23', 'Apache-2.0 OR BSL-1.0'],
    ['serde', '1.0.229', 'MIT OR Apache-2.0'],
    ['serde_core', '1.0.229', 'MIT OR Apache-2.0'],
    ['serde_derive', '1.0.229', 'MIT OR Apache-2.0'],
    ['serde_json', '1.0.154', 'MIT OR Apache-2.0'],
    ['serde_path_to_error', '0.1.20', 'MIT OR Apache-2.0'],
    ['serde_spanned', '1.1.3', 'MIT OR Apache-2.0'],
    ['serde_urlencoded', '0.7.1', 'MIT OR Apache-2.0'],
    ['sha1', '0.11.0', 'MIT OR Apache-2.0'],
    ['sha2', '0.11.1', 'MIT OR Apache-2.0'],
    ['sharded-slab', '0.1.7', 'MIT'],
    ['signal-hook-registry', '1.4.8', 'MIT OR Apache-2.0'],
    ['simd-adler32', '0.3.10', 'MIT'],
    ['slab', '0.4.12', 'MIT'],
    ['smallvec', '1.16.5', 'MIT OR Apache-2.0'],
    ['socket2', '0.6.5', 'MIT OR Apache-2.0'],
    ['stable_deref_trait', '1.2.1', 'MIT OR Apache-2.0'],
    ['subtle', '2.6.1', 'BSD-3-Clause'],
    ['syn', '3.0.10', 'MIT OR Apache-2.0'],
    ['sync_wrapper', '1.0.2', 'Apache-2.0'],
    ['synstructure', '0.14.0', 'MIT'],
    ['thread_local', '1.1.10', 'MIT OR Apache-2.0'],
    ['tinystr', '0.8.5', 'Unicode-3.0'],
    ['tokio', '1.54.1', 'MIT'],
    ['tokio-macros', '2.7.2', 'MIT'],
    ['tokio-rustls', '0.26.6', 'MIT OR Apache-2.0'],
    ['tokio-util', '0.7.20', 'MIT'],
    ['toml', '1.2.1+spec-1.1.0', 'MIT OR Apache-2.0'],
    ['toml_datetime', '1.1.3+spec-1.1.0', 'MIT OR Apache-2.0'],
    ['toml_parser', '1.1.5+spec-1.1.0', 'MIT OR Apache-2.0'],
    ['tower', '0.5.3', 'MIT'],
    ['tower-http', '0.6.11', 'MIT'],
    ['tower-http', '0.7.1', 'MIT'],
    ['tower-layer', '0.3.3', 'MIT'],
    ['tower-service', '0.3.3', 'MIT'],
    ['tracing', '0.1.44', 'MIT'],
    ['tracing-core', '0.1.36', 'MIT'],
    ['tracing-serde', '0.2.0', 'MIT'],
    ['tracing-subscriber', '0.3.23', 'MIT'],
    ['try-lock', '0.2.5', 'MIT'],
    ['typenum', '1.20.1', 'MIT OR Apache-2.0'],
    ['unicode-ident', '1.0.27', '(MIT OR Apache-2.0) AND Unicode-3.0'],
    ['untrusted', '0.9.0', 'ISC'],
    ['url', '2.5.8', 'MIT OR Apache-2.0'],
    ['utf8_iter', '1.1.0', 'Apache-2.0 OR MIT'],
    ['utf_types', '1.0.0', 'Apache-2.0 OR MIT'],
    ['want', '0.3.2', 'MIT'],
    ['webpki-roots', '1.0.12', 'CDLA-Permissive-2.0'],
    ['winnow', '1.0.5', 'MIT'],
    ['writeable', '0.6.4', 'Unicode-3.0'],
    ['yoke', '0.8.4', 'Unicode-3.0'],
    ['yoke-derive', '0.8.4', 'Unicode-3.0'],
    ['zerofrom', '0.1.8', 'Unicode-3.0'],
    ['zerofrom-derive', '0.1.8', 'Unicode-3.0'],
    ['zeroize', '1.9.1', 'Apache-2.0 OR MIT'],
    ['zerotrie', '0.2.5', 'Unicode-3.0'],
    ['zerovec', '0.11.9', 'Unicode-3.0'],
    ['zerovec-derive', '0.11.7', 'Unicode-3.0'],
    ['zmij', '1.0.23', 'MIT'],
    // END RUST_CRATES
  ] as const
).map(([name, version, license]) => ({ name, version, license }));

/** License keys mentioned in an expression, in order of appearance ("(MIT OR Apache-2.0) AND X" → MIT, Apache-2.0, X). */
export function licenseKeys(expression: string): string[] {
  const keys: string[] = [];
  for (const token of expression.replace(/[()]/g, ' ').split(/\s+/)) {
    if (!token || token === 'OR' || token === 'AND' || token === 'WITH') continue;
    if (!keys.includes(token)) keys.push(token);
  }
  return keys;
}

export function isLicenseKey(key: string): key is LicenseKey {
  return Object.hasOwn(LICENSES, key);
}

/** One piece of a rendered license expression: a linkable license or an operator word. */
export type LicensePart = { kind: 'license'; key: LicenseKey; name: string; url: string } | { kind: 'text'; text: string };

/**
 * Splits an expression for display: license ids become links with readable names, operators become lowercase
 * words ("MIT OR Apache-2.0" → MIT License · "or" · Apache License 2.0). Unknown ids are kept as plain text.
 */
export function licenseParts(expression: string): LicensePart[] {
  const parts: LicensePart[] = [];
  for (const raw of expression.split(/(\s+|[()])/)) {
    const token = raw.trim();
    if (!token) continue;
    if (token === 'OR' || token === 'AND' || token === 'WITH') parts.push({ kind: 'text', text: token.toLowerCase() });
    else if (token === '(' || token === ')') parts.push({ kind: 'text', text: token });
    else if (isLicenseKey(token)) parts.push({ kind: 'license', key: token, ...LICENSES[token] });
    else parts.push({ kind: 'text', text: token });
  }
  return parts;
}

/**
 * Whether a string is a license expression made of known ids, operators and parentheses ("MIT OR Apache-2.0"), as
 * opposed to free text a server may report for a filter list ("No explicit licence; …"), which is shown as written.
 */
export function isLicenseExpression(expression: string): boolean {
  const tokens = expression.split(/(\s+|[()])/).map((t) => t.trim()).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => t === 'OR' || t === 'AND' || t === 'WITH' || t === '(' || t === ')' || isLicenseKey(t));
}

/** Short, human label for an expression ("MIT OR Apache-2.0" → "MIT or Apache-2.0"). */
export function licenseLabel(expression: string): string {
  return expression.replace(/\b(OR|AND|WITH)\b/g, (w) => w.toLowerCase());
}

/** How many crates use each license expression, most common first (summary line above the crate table). */
export function crateLicenseSummary(crates: readonly RustCrate[] = RUST_CRATES): Array<{ license: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of crates) {
    // "Apache-2.0 OR MIT" and "MIT OR Apache-2.0" are the same choice: list MIT first, then by name.
    const key =
      c.license.includes('(') || c.license.includes('AND') || c.license.includes('WITH')
        ? c.license
        : c.license
            .split(' OR ')
            .sort((a, b) => (a === 'MIT' ? -1 : b === 'MIT' ? 1 : a.localeCompare(b)))
            .join(' OR ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([license, count]) => ({ license, count }))
    .sort((a, b) => b.count - a.count || a.license.localeCompare(b.license));
}

/** Every component, flattened (search, counts and tests). */
export function allComponents(): Component[] {
  return COMPONENT_GROUPS.flatMap((g) => g.components);
}
