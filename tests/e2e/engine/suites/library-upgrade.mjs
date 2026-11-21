// Lane d e2e: the appended IndexedDB upgrade (frontend/src/lib/idb.ts, version 1 → 2) in real Chromium and Firefox
// IndexedDB, on the real stack. A version-1 database is written with the released version-1 schema by a page of the
// app origin that does not run the app (the server's /logo.png), as a GNOME tab of the previous build would have left
// it, and that "old tab" keeps its connection open with the version-1 code's `onversionchange` handler. The current
// app then opens the database: the old connection must close, the upgrade must run, and the History, Bookmarks and
// Downloads pages must show the migrated records (download size → total, complete → completed, a running download
// → "No longer followed", a top-level bookmark with parentId null → the bookmarks bar, its favorite kept).
//
//   node tests/e2e/engine/suites/library-upgrade.mjs [--browser chromium|firefox|all]   (see library-lib.mjs)
import { isMain, runStandalone, settingsMirror } from './library-lib.mjs';
import { dump } from './library-seed-lib.mjs';

export async function run(ctx) {
  const browser = await ctx.launch();
  const check = async (test, fn) => {
    try {
      const notes = await fn();
      ctx.record({ test, result: 'pass', notes: typeof notes === 'string' ? notes : undefined });
      return true;
    } catch (err) {
      ctx.record({ test, result: 'fail', notes: String(err?.message ?? err).slice(0, 600) });
      return false;
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const context = await ctx.newContext(browser);
  const errors = [];
  try {
    await context.addInitScript(
      ([value]) => {
        if (location.pathname === '/logo.png') return;
        if (!sessionStorage.getItem('lib-e2e:seeded')) {
          localStorage.setItem('gnome:settings:v1', value);
          sessionStorage.setItem('lib-e2e:seeded', '1');
        }
      },
      [settingsMirror('dark', { browser: { history: { enabled: true, retentionDays: 0 }, downloads: { track: true, keepDays: 0 } } })],
    );
    const now = Date.now();
    const old = await context.newPage();
    const wrote = await check('a version-1 database written by an old GNOME tab (released v1 schema)', async () => {
      await old.goto(`${ctx.stack.appOrigin}/logo.png`, { waitUntil: 'load' });
      return old.evaluate(async (now) => {
        const req = indexedDB.open('gnome', 1);
        req.onupgradeneeded = () => {
          // lib/idb.ts UPGRADES[0], the released version 1.
          const db = req.result;
          db.createObjectStore('settings');
          db.createObjectStore('session');
          const history = db.createObjectStore('history', { keyPath: 'id' });
          history.createIndex('visitedAt', 'visitedAt');
          history.createIndex('url', 'url');
          const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
          bookmarks.createIndex('parentId', 'parentId');
          bookmarks.createIndex('url', 'url');
          bookmarks.createIndex('updatedAt', 'updatedAt');
          db.createObjectStore('downloads', { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
          db.createObjectStore('games_favorites', { keyPath: 'id' }).createIndex('addedAt', 'addedAt');
          db.createObjectStore('games_recent', { keyPath: 'id' }).createIndex('playedAt', 'playedAt');
          db.createObjectStore('extensions');
          db.createObjectStore('sitePermissions', { keyPath: 'host' });
          db.createObjectStore('kv');
        };
        const db = await new Promise((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        // The version-1 code's handler (lib/idb.ts openDatabase): close when another tab upgrades.
        window.__v1Closed = false;
        db.onversionchange = () => {
          db.close();
          window.__v1Closed = true;
        };
        const tx = db.transaction(['history', 'bookmarks', 'downloads'], 'readwrite');
        const hour = 3_600_000;
        tx.objectStore('history').put({ id: 'a1000000-0000-4000-8000-000000000001', url: 'https://en.wikipedia.org/wiki/Garden_gnome', title: 'Garden gnome - Wikipedia', visitedAt: now - 2 * hour });
        tx.objectStore('bookmarks').put({ id: 'b1000000-0000-4000-8000-000000000001', parentId: null, kind: 'bookmark', title: 'Version 1 favorite', url: 'https://www.openstreetmap.org/', position: 0, createdAt: now - 9 * hour, updatedAt: now - 9 * hour, deleted: false, favorite: true });
        tx.objectStore('bookmarks').put({ id: 'b1000000-0000-4000-8000-000000000002', parentId: null, kind: 'folder', title: 'Version 1 folder', url: null, position: 1, createdAt: now - 9 * hour, updatedAt: now - 9 * hour, deleted: false });
        tx.objectStore('bookmarks').put({ id: 'b1000000-0000-4000-8000-000000000003', parentId: 'b1000000-0000-4000-8000-000000000002', kind: 'bookmark', title: 'Inside the folder', url: 'https://doc.rust-lang.org/book/', position: 0, createdAt: now - 9 * hour, updatedAt: now - 9 * hour, deleted: false });
        tx.objectStore('downloads').put({ id: 'c1000000-0000-4000-8000-000000000001', url: 'https://example.com/report.pdf', filename: 'report.pdf', mime: 'application/pdf', size: 2_400_000, received: 2_400_000, state: 'complete', error: null, startedAt: now - 3 * hour, finishedAt: now - 3 * hour + 4000 });
        tx.objectStore('downloads').put({ id: 'c1000000-0000-4000-8000-000000000002', url: 'https://example.com/big.iso', filename: 'big.iso', mime: null, size: 700_000_000, received: 1_000_000, state: 'in_progress', error: null, startedAt: now - hour, finishedAt: null });
        tx.objectStore('downloads').put({ id: 'c1000000-0000-4000-8000-000000000003', url: 'https://example.com/broken.zip', filename: 'broken.zip', mime: 'application/zip', size: 10_000, received: 500, state: 'failed', error: 'Network error', startedAt: now - 2 * hour, finishedAt: now - 2 * hour + 1000 });
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        return `version ${db.version}, connection kept open`;
      }, now);
    });
    if (!wrote) return;

    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
    page.setDefaultTimeout(15_000);

    await check('the current app upgrades it: the old tab closes its connection, version 2 has the new indexes', async () => {
      await page.goto(`${ctx.stack.appOrigin}/history`, { waitUntil: 'load' });
      await page.locator('.days .row').first().waitFor();
      expect(await old.evaluate(() => window.__v1Closed), 'the old connection did not get versionchange');
      const shape = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open('gnome');
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction(['history', 'bookmarks', 'downloads']);
              const idx = (s) => [...tx.objectStore(s).indexNames].sort().join(',');
              const out = { version: db.version, history: idx('history'), bookmarks: idx('bookmarks'), downloads: idx('downloads') };
              db.close();
              resolve(out);
            };
            req.onerror = () => reject(req.error);
          }),
      );
      expect(shape.version === 2, `version ${shape.version}`);
      expect(shape.history === 'syncPending,url,visitedAt', `history indexes ${shape.history}`);
      expect(shape.bookmarks === 'parentId,syncPending,updatedAt,url', `bookmark indexes ${shape.bookmarks}`);
      expect(shape.downloads === 'instance,startedAt', `download indexes ${shape.downloads}`);
      return JSON.stringify(shape);
    });

    await check('History lists the version-1 visit unchanged (not marked for upload)', async () => {
      await page.locator('.days .row', { hasText: 'Garden gnome - Wikipedia' }).waitFor();
      const [v] = await dump(page, 'history');
      expect(v && v.syncPending === undefined && v.title === 'Garden gnome - Wikipedia', JSON.stringify(v));
    });

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

    await check('Bookmarks shows the top-level version-1 items on the bar, the favorite kept, the folder with its bookmark', async () => {
      await go('/bookmarks');
      await page.locator('.list .row', { hasText: 'Version 1 favorite' }).waitFor();
      await page.locator('.list .row', { hasText: 'Version 1 folder' }).waitFor();
      const star = page.locator('.list .row', { hasText: 'Version 1 favorite' }).getByRole('button', { name: /from favorites$/ });
      expect((await star.getAttribute('aria-pressed')) === 'true', 'the favorite was lost');
      const stored = (await dump(page, 'bookmarks')).filter((b) => b.title.startsWith('Version 1'));
      expect(stored.length === 2 && stored.every((b) => b.parentId === 'root'), JSON.stringify(stored.map((b) => b.parentId)));
      await page.locator('.list .row', { hasText: 'Version 1 folder' }).locator('a.main').click();
      await page.locator('.list .row', { hasText: 'Inside the folder' }).waitFor();
    });

    await check('Downloads shows the migrated list: completed with its size, a running one "No longer followed", the failure', async () => {
      await go('/downloads');
      const row = (name) => page.locator('.row', { hasText: name });
      await row('report.pdf').waitFor();
      expect(/Completed/.test(await row('report.pdf').textContent()) && /2\.4\s?MB|2\.3\s?MB/.test(await row('report.pdf').textContent()), (await row('report.pdf').textContent()).trim());
      expect(/No longer followed/.test(await row('big.iso').textContent()), (await row('big.iso').textContent()).trim());
      expect(/Failed/.test(await row('broken.zip').textContent()) && /Network error/.test(await row('broken.zip').textContent()), (await row('broken.zip').textContent()).trim());
      const stored = await dump(page, 'downloads');
      expect(stored.every((d) => !('size' in d) && d.instance === 'legacy' && typeof d.engine === 'string'), JSON.stringify(stored[0]));
    });

    await check('no page errors', async () => {
      if (errors.length) throw new Error(errors.slice(0, 5).join(' | '));
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

if (isMain(import.meta.url)) await runStandalone(run, 'library-upgrade');
