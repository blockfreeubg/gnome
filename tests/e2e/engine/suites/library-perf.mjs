// Lane d e2e: the library at its limits on the real stack (gnome-server serving the built app), in Chromium and
// Firefox: 100 000 history visits (the history store's cap, and what the sync server keeps) and 20 000 bookmarks (the
// bookmark cap). It times what a user waits for: the History page's first rows, a search that has to look through
// every visit, paging, clearing everything; the Bookmarks page, a folder and a search; and that 1000 more visits
// recorded through the store leave it at the cap. Each row passes under a limit (LIBRARY_PERF_SLACK scales them).
//
//   node tests/e2e/engine/suites/library-perf.mjs [--browser chromium|firefox|all]   (see library-lib.mjs)
import { isMain, runStandalone, settingsMirror } from './library-lib.mjs';

const VISITS = 100_000;
const FOLDERS = 200;
const PER_FOLDER = 99;
const SLACK = Number(process.env.LIBRARY_PERF_SLACK || 1);

export async function run(ctx) {
  const browser = await ctx.launch();
  const timed = async (test, limitMs, fn) => {
    const t0 = Date.now();
    try {
      const extra = await fn();
      const ms = Date.now() - t0;
      const ok = ms <= limitMs * SLACK;
      ctx.record({ test, result: ok ? 'pass' : 'fail', notes: `${ms} ms (limit ${Math.round(limitMs * SLACK)} ms)${extra ? `; ${extra}` : ''}` });
      return ms;
    } catch (err) {
      ctx.record({ test, result: 'fail', notes: `after ${Date.now() - t0} ms: ${String(err?.message ?? err).slice(0, 500)}` });
      return null;
    }
  };
  const context = await ctx.newContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    await context.addInitScript(
      ([value]) => {
        if (!sessionStorage.getItem('lib-e2e:seeded')) {
          localStorage.setItem('gnome:settings:v1', value);
          sessionStorage.setItem('lib-e2e:seeded', '1');
        }
      },
      [settingsMirror('dark', { browser: { history: { enabled: true, retentionDays: 0 } } })],
    );
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const go = async (to) => {
      await page.evaluate((p) => {
        const a = document.createElement('a');
        a.href = p;
        document.body.append(a);
        a.click();
        a.remove();
      }, to);
      await page.waitForFunction((p) => location.pathname + location.search === p, to);
    };

    await page.goto(`${ctx.stack.appOrigin}/about`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500); // the app's start (the browser starts when the page is idle)

    const seeded = await timed('seed 100 000 visits and 20 000 bookmarks (IndexedDB, in the page)', 120_000, async () => {
      const n = await page.evaluate(
        async ({ VISITS, FOLDERS, PER_FOLDER }) => {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('gnome');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const put = (store, rows) =>
            new Promise((resolve, reject) => {
              const tx = db.transaction(store, 'readwrite');
              const os = tx.objectStore(store);
              for (const r of rows) os.put(r);
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            });
          const hex = (n, w = 12) => n.toString(16).padStart(w, '0');
          const words = ['garden', 'gnome', 'rust', 'svelte', 'kernel', 'proxy', 'browser', 'river', 'mountain', 'bread', 'plum', 'cake', 'radio', 'train', 'castle', 'forest'];
          const sites = Array.from({ length: 2000 }, (_, i) => ({
            url: `https://site${i % 400}.example.org/${words[i % 16]}/${words[(i * 7) % 16]}-${i}`,
            title: `${words[(i * 3) % 16]} ${words[(i * 5) % 16]} ${i} – Example ${i % 400}`,
          }));
          const now = Date.now();
          const span = 90 * 86_400_000;
          for (let start = 0; start < VISITS; start += 10_000) {
            const rows = [];
            for (let i = start; i < Math.min(VISITS, start + 10_000); i++) {
              const s = sites[(i * 7919) % sites.length];
              // Three visits of a page nobody else matches, at the oldest end: a search for it reads every visit.
              const rare = i >= VISITS - 3;
              rows.push({
                id: `e0000000-0000-4000-8000-${hex(i + 1)}`,
                url: rare ? `https://kitchen.example.net/zwetschgenkuchen-${i}` : s.url,
                title: rare ? `Zwetschgenkuchen ${i}` : s.title,
                visitedAt: now - 60_000 - Math.floor((i / VISITS) * span),
              });
            }
            await put('history', rows);
          }
          const t = now - 40 * 86_400_000;
          const bookmarks = [];
          for (let f = 0; f < FOLDERS; f++) {
            const fid = `f0000000-0000-4000-8000-${hex(f + 1)}`;
            bookmarks.push({ id: fid, parentId: 'root', kind: 'folder', title: `Folder ${f + 1} ${words[f % 16]}`, url: null, position: f, createdAt: t, updatedAt: t, deleted: false, favorite: false });
            for (let k = 0; k < PER_FOLDER; k++) {
              const s = sites[(f * PER_FOLDER + k) % sites.length];
              bookmarks.push({
                id: `b1000000-0000-4000-8000-${hex(f * PER_FOLDER + k + 1)}`,
                parentId: fid,
                kind: 'bookmark',
                title: f === FOLDERS - 1 && k === PER_FOLDER - 1 ? 'Zwetschgenkuchen recipe' : s.title,
                url: s.url,
                position: k,
                createdAt: t + k,
                updatedAt: t + k,
                deleted: false,
                favorite: k === 0 && f < 12,
              });
            }
          }
          for (let start = 0; start < bookmarks.length; start += 10_000) await put('bookmarks', bookmarks.slice(start, start + 10_000));
          const count = await new Promise((resolve) => {
            const req = db.transaction('history').objectStore('history').count();
            req.onsuccess = () => resolve(req.result);
          });
          db.close();
          return count;
        },
        { VISITS, FOLDERS, PER_FOLDER },
      );
      if (n !== VISITS) throw new Error(`${n} visits stored`);
    });
    if (seeded === null) return;

    const summary = () => page.locator('.summary').first().textContent().then((s) => s?.trim() ?? '');
    const rowCount = () => page.locator('.days .row').count();
    const search = page.getByRole('searchbox', { name: 'Search history' });

    await timed('History page: first rows and the total of 100 000 visits', 4000, async () => {
      await go('/history');
      await page.locator('.days .row').first().waitFor();
      await page.waitForFunction(() => /100[,. ]?000 visits/.test(document.querySelector('.summary')?.textContent ?? ''));
      return `${await rowCount()} rows rendered`;
    });

    await timed('History: "Show older visits" loads the next page', 2000, async () => {
      const before = await rowCount();
      await page.getByRole('button', { name: 'Show older visits' }).click();
      await page.waitForFunction((n) => document.querySelectorAll('.days .row').length > n, before);
      return `${before} → ${await rowCount()} rows`;
    });

    await timed('History: a search that reads all 100 000 visits (3 matches at the oldest end)', 8000, async () => {
      await search.fill('zwetschgenkuchen');
      await page.waitForFunction(() => document.querySelectorAll('.days .row').length === 3 && /zwetschgenkuchen/i.test(document.querySelector('.days .row .title')?.textContent ?? ''));
      return await summary();
    });

    await timed('History: a common word (many matches, first page only)', 2000, async () => {
      await search.fill('castle');
      // A visit matches on its title or its address (the row shows both).
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('.days .row .main')];
        return rows.length >= 150 && rows.every((r) => /castle/i.test(r.textContent ?? ''));
      });
      return await summary();
    });

    await timed('History: typing a word letter by letter (each step searches) settles on the last one', 10_000, async () => {
      await search.fill('');
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'));
      await search.pressSequentially('zwetsch', { delay: 60 });
      await page.waitForFunction(() => document.querySelectorAll('.days .row').length === 3);
    });

    await timed('History: 1000 visits over the cap are trimmed at the next start (the oldest go)', 30_000, async () => {
      await search.fill('');
      await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'));
      // Written into IndexedDB as another device's sync or an older build would leave them; the library's start runs
      // prune(), which trims the store to its cap (recordVisit checks it every 500 visits: unit-tested).
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('gnome');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const tx = db.transaction('history', 'readwrite');
        const os = tx.objectStore('history');
        const now = Date.now();
        for (let i = 0; i < 1000; i++) os.put({ id: `e1000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, url: `https://flood.example/${i}`, title: null, visitedAt: now - i });
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await page.reload({ waitUntil: 'networkidle' });
      const stored = () =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              const req = indexedDB.open('gnome');
              req.onsuccess = () => {
                const c = req.result.transaction('history').objectStore('history').count();
                c.onsuccess = () => {
                  req.result.close();
                  resolve(c.result);
                };
              };
            }),
        );
      await page
        .waitForFunction(() => /100[,. ]?000 visits/.test(document.querySelector('.summary')?.textContent ?? ''), null, { timeout: 25_000 })
        .catch(async (err) => {
          throw new Error(`${err.message}; summary "${await summary()}", ${await stored()} visits stored, at ${page.url()}`);
        });
      const oldestGone = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open('gnome');
            req.onsuccess = () => {
              const g = req.result.transaction('history').objectStore('history').get('e0000000-0000-4000-8000-0000000186a0');
              g.onsuccess = () => {
                req.result.close();
                resolve(g.result === undefined);
              };
            };
          }),
      );
      if (!oldestGone) throw new Error('the oldest visit is still stored');
      return await summary();
    });

    // ── Bookmarks ──
    await timed('Bookmarks page with 20 000 items: the bar (200 folders) and the tree', 4000, async () => {
      await go('/bookmarks');
      await page.locator('.list .row').first().waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 200);
      await page.waitForFunction(() => /19[,. ]?800 bookmarks/.test(document.querySelector('.summary')?.textContent ?? ''));
      return `${await page.locator('.tree .node').count()} tree nodes`;
    });

    await timed('Bookmarks: open a folder of 99', 1500, async () => {
      await page.getByRole('navigation', { name: 'Bookmark folders' }).getByRole('button', { name: /Folder 137 / }).click();
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 99);
    });

    await timed('Bookmarks: search across 20 000 items', 2000, async () => {
      await page.getByRole('searchbox', { name: 'Search bookmarks' }).fill('zwetschgenkuchen');
      await page.getByRole('heading', { name: 'Results for “zwetschgenkuchen”' }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 1);
      await page.getByRole('searchbox', { name: 'Search bookmarks' }).fill('');
    });

    await timed('Bookmarks: star a bookmark (write + list refresh)', 2000, async () => {
      await go('/bookmarks?view=favorites');
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 12);
      await page.locator('.list .row').first().getByRole('button', { name: /^Remove .* from favorites$/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 11);
    });

    // ── Clearing ──
    await timed('History: Clear history → All time with 100 000 visits', 5000, async () => {
      await go('/history');
      await page.locator('.days .row').first().waitFor();
      await page.getByRole('button', { name: 'Clear history…' }).click();
      const dlg = page.getByRole('dialog', { name: 'Clear history' });
      await dlg.getByRole('radio', { name: 'All time' }).check();
      await dlg.getByRole('button', { name: 'Clear history' }).click();
      await page.getByText('No history yet').waitFor();
    });

    ctx.record({ test: 'no page errors', result: errors.length ? 'fail' : 'pass', notes: errors.slice(0, 5).join(' | ') || undefined });
  } finally {
    await context.close();
    await browser.close();
  }
}

if (isMain(import.meta.url)) await runStandalone(run, 'library-perf');
