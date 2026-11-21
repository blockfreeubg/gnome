// Realistic seed data for the library suites: ten days of history, a bookmark tree with folders and favorites, and
// downloads in every state. Records use the IndexedDB shapes of frontend/src/lib/idb.ts (database version 2), and
// seed() writes them into the app origin's `gnome` database exactly as the stores would.
const DAY = 86_400_000;

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const PAGES = [
  ['https://en.wikipedia.org/wiki/Garden_gnome', 'Garden gnome - Wikipedia'],
  ['https://en.wikipedia.org/wiki/Raspberry_Pi', 'Raspberry Pi - Wikipedia'],
  ['https://en.wikipedia.org/wiki/Rust_(programming_language)', 'Rust (programming language) - Wikipedia'],
  ['https://de.wikipedia.org/wiki/Gartenzwerg', 'Gartenzwerg – Wikipedia'],
  ['https://github.com/MercuryWorkshop/scramjet', 'GitHub - MercuryWorkshop/scramjet: Interception-based web proxy'],
  ['https://github.com/sveltejs/svelte', 'GitHub - sveltejs/svelte: web development for the rest of us'],
  ['https://github.com/titaniumnetwork-dev/Ultraviolet', 'GitHub - titaniumnetwork-dev/Ultraviolet: Advanced web proxy'],
  ['https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API', 'IndexedDB API - Web APIs | MDN'],
  ['https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API', 'Service Worker API - Web APIs | MDN'],
  ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy', 'Content-Security-Policy - HTTP | MDN'],
  ['https://docs.rs/tokio/latest/tokio/', 'tokio - Rust'],
  ['https://doc.rust-lang.org/book/ch16-00-concurrency.html', 'Fearless Concurrency - The Rust Programming Language'],
  ['https://svelte.dev/docs/svelte/$state', '$state • Svelte Docs'],
  ['https://news.ycombinator.com/', 'Hacker News'],
  ['https://news.ycombinator.com/item?id=41234567', 'Show HN: A browser inside a web page | Hacker News'],
  ['https://lwn.net/Articles/992143/', 'Rust in the kernel: one year later [LWN.net]'],
  ['https://www.openstreetmap.org/#map=13/52.5200/13.4050', 'OpenStreetMap'],
  ['https://archive.org/details/texts', 'eBooks and Texts : Internet Archive'],
  ['https://duckduckgo.com/?q=sourdough+starter+ratio', 'sourdough starter ratio at DuckDuckGo'],
  ['https://www.seriouseats.com/how-to-make-sourdough-starter', 'How to Make a Sourdough Starter | Serious Eats'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Never Gonna Give You Up - YouTube'],
  ['https://www.raspberrypi.com/documentation/computers/getting-started.html', 'Getting started - Raspberry Pi Documentation'],
  ['https://caddyserver.com/docs/quick-starts/reverse-proxy', 'Reverse proxy quick-start — Caddy Documentation'],
  ['https://www.bbc.co.uk/news/technology', 'Technology - BBC News'],
  ['https://www.theguardian.com/environment', 'Environment | The Guardian'],
  ['https://store.steampowered.com/app/105600/Terraria/', 'Terraria on Steam'],
  ['https://kitchen.example.org/recipes/plum-cake', 'Plum cake (Zwetschgenkuchen)'],
];

export function seedData(now = Date.now()) {
  const r = rng(42);
  const history = [];
  let n = 0;
  // Ten days, busier today; visits during waking hours.
  for (let day = 0; day < 10; day++) {
    const count = day === 0 ? 18 : 6 + Math.floor(r() * 8);
    const midnight = new Date(now - day * DAY);
    midnight.setHours(0, 0, 0, 0);
    for (let i = 0; i < count; i++) {
      const [url, title] = PAGES[Math.floor(r() * PAGES.length)];
      let at = midnight.getTime() + (8 + r() * 14) * 3600_000;
      if (day === 0) at = now - (i + 1) * (11 + Math.floor(r() * 20)) * 60_000; // today: the last hours, newest first
      if (at > now) at = now - 60_000 * (i + 1);
      history.push({ id: uuid('a0000000', ++n), url, title, visitedAt: Math.round(at) });
    }
  }
  // One visit within the last 20 minutes (the "Last hour" clear check), and one without a title.
  history.push({ id: uuid('a0000000', ++n), url: 'https://example.com/', title: 'Example Domain', visitedAt: now - 20 * 60_000 });
  history.push({ id: uuid('a0000000', ++n), url: 'https://httpbin.org/get?show_env=1', title: null, visitedAt: now - 3 * DAY - 3600_000 });

  const t = now - 30 * DAY;
  const b = (id, parentId, kind, title, url, position, favorite = false) => ({
    id: uuid('b0000000', id),
    parentId,
    kind,
    title,
    url,
    position,
    createdAt: t + id * 60_000,
    updatedAt: t + id * 60_000,
    deleted: false,
    favorite,
  });
  const reading = uuid('b0000000', 10);
  const projects = uuid('b0000000', 20);
  const pi = uuid('b0000000', 30);
  const kitchen = uuid('b0000000', 40);
  const bookmarks = [
    b(1, 'root', 'bookmark', 'Svelte docs', 'https://svelte.dev/docs/svelte/overview', 0, true),
    b(2, 'root', 'bookmark', 'MDN Web Docs', 'https://developer.mozilla.org/en-US/', 1, true),
    b(10, 'root', 'folder', 'Reading list', null, 2),
    b(20, 'root', 'folder', 'Projects', null, 3),
    b(40, 'root', 'folder', 'Kitchen', null, 4),
    b(3, 'root', 'bookmark', 'Hacker News', 'https://news.ycombinator.com/', 5),
    b(11, reading, 'bookmark', 'Rust in the kernel: one year later', 'https://lwn.net/Articles/992143/', 0),
    b(12, reading, 'bookmark', 'The Rust Programming Language', 'https://doc.rust-lang.org/book/', 1, true),
    b(13, reading, 'bookmark', 'Garden gnome - Wikipedia', 'https://en.wikipedia.org/wiki/Garden_gnome', 2),
    b(14, reading, 'bookmark', 'Show HN: A browser inside a web page', 'https://news.ycombinator.com/item?id=41234567', 3),
    b(21, projects, 'bookmark', 'MercuryWorkshop/scramjet', 'https://github.com/MercuryWorkshop/scramjet', 0),
    b(22, projects, 'bookmark', 'Caddy reverse proxy', 'https://caddyserver.com/docs/quick-starts/reverse-proxy', 1),
    b(30, projects, 'folder', 'Raspberry Pi', null, 2),
    b(31, pi, 'bookmark', 'Getting started', 'https://www.raspberrypi.com/documentation/computers/getting-started.html', 0),
    b(32, pi, 'bookmark', 'Raspberry Pi - Wikipedia', 'https://en.wikipedia.org/wiki/Raspberry_Pi', 1),
    b(33, pi, 'bookmark', 'Raspberry Pi OS images', 'https://www.raspberrypi.com/software/operating-systems/', 2),
    b(41, kitchen, 'bookmark', 'How to make a sourdough starter', 'https://www.seriouseats.com/how-to-make-sourdough-starter', 0, true),
    b(42, kitchen, 'bookmark', 'Plum cake (Zwetschgenkuchen)', 'https://kitchen.example.org/recipes/plum-cake', 1),
  ];

  const d = (id, over) => ({
    id: uuid('c0000000', id),
    url: 'https://downloads.example.org/file',
    filename: 'file',
    mime: null,
    total: null,
    received: 0,
    state: 'completed',
    error: null,
    engine: 'scramjet',
    instance: 'seed-instance',
    downloadId: String(id),
    page: 'seed-page',
    startedAt: now - id * 3600_000,
    finishedAt: now - id * 3600_000 + 90_000,
    ...over,
  });
  const downloads = [
    d(1, {
      url: 'https://downloads.raspberrypi.com/raspios_lite_arm64/images/2026-10-28-raspios-trixie-arm64-lite.img.xz',
      filename: '2026-10-28-raspios-trixie-arm64-lite.img.xz',
      mime: 'application/x-xz',
      total: 512_000_000,
      received: 221_184_000,
      state: 'in_progress',
      startedAt: now - 4 * 60_000,
      finishedAt: null,
      instance: 'seed-live',
    }),
    d(2, { url: 'https://www.w3.org/WAI/WCAG22/wcag-2.2.pdf', filename: 'wcag-2.2.pdf', mime: 'application/pdf', total: 1_843_200, received: 1_843_200, startedAt: now - 50 * 60_000 }),
    d(3, { url: 'https://github.com/sveltejs/svelte/archive/refs/heads/main.zip', filename: 'svelte-main.zip', mime: 'application/zip', total: 18_874_368, received: 18_874_368, engine: 'ultraviolet', startedAt: now - 2.5 * 3600_000 }),
    d(4, { url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.2.0-amd64-netinst.iso', filename: 'debian-13.2.0-amd64-netinst.iso', mime: 'application/x-iso9660-image', total: 790_626_304, received: 103_809_024, state: 'failed', error: 'The connection was reset by the server.', startedAt: now - 5 * 3600_000 }),
    d(5, { url: 'https://upload.wikimedia.org/wikipedia/commons/5/5f/Gartenzwerg.png', filename: 'Gartenzwerg.png', mime: 'image/png', total: 482_113, received: 482_113, startedAt: now - 26 * 3600_000 }),
    d(6, { url: 'https://example.org/reports/annual-2025.xlsx', filename: 'annual-2025.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', total: 92_160, received: 30_720, state: 'cancelled', error: 'Cancelled', startedAt: now - 28 * 3600_000 }),
    d(7, { url: 'https://releases.example.net/podcast/episode-118.mp3', filename: 'episode-118.mp3', mime: 'audio/mpeg', total: 61_865_984, received: 12_582_912, state: 'untracked', finishedAt: null, engine: 'ultraviolet', startedAt: now - 3 * DAY }),
  ];
  return { history, bookmarks, downloads };
}

/**
 * Writes the records into the app's IndexedDB (call on an app page that already opened it, then reload).
 * `clear` empties the three stores first.
 */
export async function seed(page, data, { clear = true } = {}) {
  await page.waitForFunction(() =>
    new Promise((resolve) => {
      const req = indexedDB.open('gnome');
      req.onsuccess = () => {
        const ok = req.result.version >= 2;
        req.result.close();
        resolve(ok);
      };
      req.onerror = () => resolve(false);
    }),
  );
  await page.evaluate(
    async ({ data, clear }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('gnome');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction(['history', 'bookmarks', 'downloads'], 'readwrite');
      for (const store of ['history', 'bookmarks', 'downloads']) {
        if (clear) tx.objectStore(store).clear();
        for (const r of data[store] ?? []) tx.objectStore(store).put(r);
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { data, clear },
  );
}

/** Reads a store of the app's IndexedDB. */
export function dump(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('gnome');
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
    store,
  );
}
