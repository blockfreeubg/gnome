// Lane d e2e: bookmark and history sync between two devices (browser contexts) through a real gnome-server with
// accounts (GNOME_ACCOUNTS=true, open registration), in Chromium and Firefox. Device A registers through Settings →
// Account & sync, adds a folder and a bookmark through the Bookmarks page (one a favorite) and has visits; "Sync now"
// uploads them: the server holds the folder with `parent_id: null` (the root sentinel mapped at the sync boundary),
// the bookmark inside it, no `favorite` field, and the visits. Device B signs in and receives them (the favorite
// stays device-local). A deletion on B reaches A. History sync stays off while `account.syncHistory` is off.
//
//   node tests/e2e/engine/suites/library-sync.mjs [--browser chromium|firefox|all]   (see library-lib.mjs)
import { isMain, runStandalone, settingsMirror } from './library-lib.mjs';
import { dump, seed } from './library-seed-lib.mjs';

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
  const waitFor = async (fn, what, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await ctx.sleep(300);
    }
  };

  const user = `lib${ctx.browser.slice(0, 2)}${Date.now().toString(36)}`;
  const password = 'correct horse battery staple';
  const account = (syncHistory) => ({ account: { sync: true, syncSettings: true, syncBookmarks: true, syncHistory } });

  async function device(syncHistory = true) {
    const context = await ctx.newContext(browser);
    await context.addInitScript(
      ([value]) => {
        if (!sessionStorage.getItem('lib-e2e:seeded')) {
          localStorage.setItem('gnome:settings:v1', value);
          sessionStorage.setItem('lib-e2e:seeded', '1');
        }
      },
      [settingsMirror('dark', account(syncHistory))],
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    return { context, page };
  }

  const go = async (page, to) => {
    await page.evaluate((p) => {
      const a = document.createElement('a');
      a.href = p;
      document.body.append(a);
      a.click();
      a.remove();
    }, to);
    await page.waitForFunction((p) => location.pathname + location.search === p, to);
    await page.waitForSelector('h1');
  };
  const syncNow = async (page) => {
    await go(page, '/settings/account');
    const before = await page.evaluate(() => Date.now());
    await page.locator('[data-row$=".sync"]').first().getByRole('button', { name: 'Sync now' }).click();
    await page.getByText(/Last synced/).waitFor();
    return before;
  };
  /** Sync now, then the account page's status line once the run ended ("Last synced …" or "Sync failed: …"). */
  const syncOutcome = async (page) => {
    await go(page, '/settings/account');
    await page.locator('[data-row$=".sync"]').first().getByRole('button', { name: 'Sync now' }).click();
    const line = page.getByText(/^(Last synced|Sync failed)/).first();
    await line.waitFor();
    await page.waitForTimeout(300);
    return (await line.textContent())?.trim() ?? '';
  };
  const post = (page, path, body) =>
    page.evaluate(
      ([p, b]) =>
        fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-gnome-request': '1' }, body: JSON.stringify(b) }).then(async (r) => ({
          status: r.status,
          body: await r.json().catch(() => null),
        })),
      [path, body],
    );
  const api = (page, path) => page.evaluate((p) => fetch(p, { credentials: 'same-origin' }).then((r) => r.json()), path);

  const a = await device(true);
  const b = await device(true);
  try {
    const FOLDER = 'Synced from device A';
    const registered = await check('device A registers through Settings → Account & sync', async () => {
      await a.page.goto(`${ctx.stack.appOrigin}/settings/account`, { waitUntil: 'networkidle' });
      await a.page.getByRole('button', { name: 'Create one', exact: true }).click();
      await a.page.getByLabel('Username').fill(user);
      await a.page.getByLabel('Password', { exact: true }).fill(password);
      await a.page.getByLabel('Confirm password').fill(password);
      await a.page.getByRole('button', { name: 'Create account' }).last().click();
      await a.page.waitForSelector(`text=${user}`);
    });
    if (!registered) return;

    await check('device A: bookmarks and visits upload with the root sentinel mapped to parent_id null', async () => {
      // The app has started (the browser starts when the page is idle); the visits are written as the history store
      // writes them (syncPending set), the bookmarks through the Bookmarks page.
      await a.page.waitForTimeout(2500);
      const now = Date.now();
      await seed(
        a.page,
        {
          history: [
            { id: 'd1000000-0000-4000-8000-000000000001', url: 'https://en.wikipedia.org/wiki/Garden_gnome', title: 'Garden gnome - Wikipedia', visitedAt: now - 60_000, syncPending: now - 60_000 },
            { id: 'd1000000-0000-4000-8000-000000000002', url: 'https://www.openstreetmap.org/', title: 'OpenStreetMap', visitedAt: now - 30_000, syncPending: now - 30_000 },
          ],
        },
        { clear: false },
      );
      await go(a.page, '/bookmarks');
      await a.page.getByRole('button', { name: 'New folder' }).click();
      let dlg = a.page.getByRole('dialog', { name: 'New folder' });
      await dlg.getByLabel('Name').fill(FOLDER);
      await dlg.getByRole('button', { name: 'Create folder' }).click();
      await a.page.locator('.list .row', { hasText: FOLDER }).locator('a.main').click();
      await a.page.getByRole('heading', { name: FOLDER }).waitFor();
      await a.page.getByRole('button', { name: 'Add bookmark' }).first().click();
      dlg = a.page.getByRole('dialog', { name: 'Add bookmark' });
      await dlg.getByLabel('Address').fill('https://doc.rust-lang.org/book/');
      await dlg.getByLabel('Name').fill('The Rust Book');
      await dlg.getByText('Show on Home under Favorites').click();
      await dlg.getByRole('button', { name: 'Add bookmark' }).click();
      await a.page.locator('.list .row', { hasText: 'The Rust Book' }).waitFor();
      await syncNow(a.page);
      await waitFor(async () => (await api(a.page, '/api/sync/bookmarks')).items?.some((x) => x.title === 'The Rust Book'), 'bookmark on the server');
      const items = (await api(a.page, '/api/sync/bookmarks')).items;
      const folder = items.find((x) => x.title === FOLDER);
      const bm = items.find((x) => x.title === 'The Rust Book');
      expect(folder && folder.parent_id === null && folder.kind === 'folder' && folder.url === null, `folder ${JSON.stringify(folder)}`);
      expect(bm && bm.parent_id === folder.id && bm.url === 'https://doc.rust-lang.org/book/' && !('favorite' in bm), `bookmark ${JSON.stringify(bm)}`);
      const hist = (await api(a.page, '/api/sync/history')).items;
      expect(['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002'].every((id) => hist.some((h) => h.id === id)), `history ${JSON.stringify(hist)}`);
      // Acknowledged: nothing is pending locally any more.
      const pendingLeft = [...(await dump(a.page, 'bookmarks')), ...(await dump(a.page, 'history'))].filter((r) => r.syncPending !== undefined);
      expect(!pendingLeft.length, `${pendingLeft.length} records still pending`);
      return `${items.length} bookmarks, ${hist.length} visits on the server`;
    });

    await check('device B signs in and receives the folder, the bookmark (not as a favorite) and the visits', async () => {
      await b.page.goto(`${ctx.stack.appOrigin}/settings/account`, { waitUntil: 'networkidle' });
      await b.page.waitForTimeout(2500); // the app's start (and its idle work) is done before anything syncs
      await b.page.getByLabel('Username').fill(user);
      await b.page.getByLabel('Password', { exact: true }).fill(password);
      await b.page.getByRole('button', { name: 'Sign in' }).last().click();
      await b.page.waitForSelector(`text=${user}`);
      await waitFor(async () => (await dump(b.page, 'bookmarks')).some((x) => x.title === 'The Rust Book'), 'bookmark on device B');
      await go(b.page, '/bookmarks');
      await b.page.locator('.list .row', { hasText: FOLDER }).locator('a.main').click();
      await b.page.locator('.list .row', { hasText: 'The Rust Book' }).waitFor();
      const rec = (await dump(b.page, 'bookmarks')).find((x) => x.title === 'The Rust Book');
      const folder = (await dump(b.page, 'bookmarks')).find((x) => x.title === FOLDER);
      expect(folder.parentId === 'root' && rec.parentId === folder.id, `stored parents ${folder.parentId} / ${rec.parentId}`);
      expect(rec.favorite !== true, 'favorite was synced');
      await waitFor(async () => (await dump(b.page, 'history')).some((h) => h.id === 'd1000000-0000-4000-8000-000000000002'), 'visits on device B');
      await go(b.page, '/history');
      await b.page.locator('.days .row', { hasText: 'OpenStreetMap' }).waitFor();
    });

    await check('a deletion on device B reaches device A', async () => {
      await go(b.page, '/bookmarks');
      await b.page.locator('.list .row', { hasText: FOLDER }).getByRole('button', { name: `Actions for ${FOLDER}` }).click();
      await b.page.getByRole('menuitem', { name: 'Delete folder' }).click();
      await b.page.locator('.list .row', { hasText: FOLDER }).waitFor({ state: 'detached' });
      await syncNow(b.page);
      await waitFor(async () => {
        const items = (await api(b.page, '/api/sync/bookmarks')).items;
        return items.filter((x) => x.deleted).length >= 2;
      }, 'tombstones on the server');
      await syncNow(a.page);
      await waitFor(async () => !(await dump(a.page, 'bookmarks')).some((x) => x.title === FOLDER || x.title === 'The Rust Book'), 'deleted on device A');
      // Acknowledged tombstones are purged locally on B.
      expect(!(await dump(b.page, 'bookmarks')).some((x) => x.deleted), 'tombstones kept after the upload');
    });

    const REFUSED = 'http://a$b.example/';
    await check('the server refuses a whole batch for one host the URL parser accepts (422), and the editor refuses it', async () => {
      const parsed = await a.page.evaluate((u) => new URL(u).href, REFUSED);
      expect(parsed === REFUSED, `the browser's URL parser gives ${parsed}`);
      const now = Date.now();
      const item = (id, url, title) => ({ id, parent_id: null, kind: 'bookmark', title, url, position: 900, created_at: now, updated_at: now, deleted: false });
      const res = await post(a.page, '/api/sync/bookmarks', {
        items: [item('d3000000-0000-4000-8000-000000000001', 'https://batch-mate.example/', 'Batch mate'), item('d3000000-0000-4000-8000-000000000002', REFUSED, 'Refused')],
      });
      expect(res.status === 422, `POST answered ${res.status} ${JSON.stringify(res.body)}`);
      const items = (await api(a.page, '/api/sync/bookmarks')).items;
      expect(!items.some((x) => x.title === 'Batch mate'), 'the valid item of the refused batch was stored');
      await go(a.page, '/bookmarks');
      await a.page.getByRole('button', { name: 'Add bookmark' }).first().click();
      const dlg = a.page.getByRole('dialog', { name: 'Add bookmark' });
      await dlg.getByLabel('Address').fill(REFUSED);
      await dlg.getByRole('button', { name: 'Add bookmark' }).click();
      await dlg.getByText(/Enter a valid web address/).waitFor();
      await dlg.getByRole('button', { name: 'Cancel' }).click();
      return `422: ${JSON.stringify(res.body?.error?.fields ?? res.body).slice(0, 160)}`;
    });

    await check('a stored record the server would refuse stays on this device; everything else still syncs', async () => {
      // As an older build could have left them: written straight into IndexedDB, marked for upload.
      const now = Date.now();
      const rec = (id, url, title) => ({ id, parentId: 'root', kind: 'bookmark', title, url, position: 901, createdAt: now, updatedAt: now, deleted: false, syncPending: now });
      await seed(a.page, { bookmarks: [rec('d4000000-0000-4000-8000-000000000001', REFUSED, 'Refused host'), rec('d4000000-0000-4000-8000-000000000002', 'https://valid-next-to-it.example/', 'Valid next to it')], history: [{ id: 'd4000000-0000-4000-8000-000000000003', url: REFUSED, title: 'Refused visit', visitedAt: now, syncPending: now }] }, { clear: false });
      const outcome = await syncOutcome(a.page);
      expect(/^Last synced/.test(outcome), `sync: ${outcome}`);
      const items = (await api(a.page, '/api/sync/bookmarks')).items;
      expect(items.some((x) => x.title === 'Valid next to it'), 'the valid bookmark was not uploaded');
      expect(!items.some((x) => x.title === 'Refused host'), 'the refused one was uploaded');
      const local = (await dump(a.page, 'bookmarks')).find((x) => x.title === 'Refused host');
      expect(local && local.syncPending === undefined, `local copy ${JSON.stringify(local)}`);
      const visit = (await dump(a.page, 'history')).find((x) => x.title === 'Refused visit');
      expect(visit && visit.syncPending === undefined, `local visit ${JSON.stringify(visit)}`);
      return outcome;
    });

    await check('two devices that edit a bookmark with the same stamp converge on the copy the server kept', async () => {
      const t = Date.now() - 5000;
      const rec = (title) => ({ id: 'd5000000-0000-4000-8000-000000000001', parentId: 'root', kind: 'bookmark', title, url: 'https://tie.example/', position: 902, createdAt: t, updatedAt: t, deleted: false, syncPending: t });
      await seed(a.page, { bookmarks: [rec('Tie: edit on A')] }, { clear: false });
      await seed(b.page, { bookmarks: [rec('Tie: edit on B')] }, { clear: false });
      await syncNow(a.page); // the server keeps A's copy
      await syncNow(b.page); // B's copy ties and loses
      await syncNow(b.page);
      await syncNow(a.page);
      const server = (await api(a.page, '/api/sync/bookmarks')).items.find((x) => x.id === 'd5000000-0000-4000-8000-000000000001');
      const onA = (await dump(a.page, 'bookmarks')).find((x) => x.id === 'd5000000-0000-4000-8000-000000000001');
      const onB = (await dump(b.page, 'bookmarks')).find((x) => x.id === 'd5000000-0000-4000-8000-000000000001');
      expect(server?.title === 'Tie: edit on A', `server ${server?.title}`);
      expect(onA?.title === server.title && onB?.title === server.title, `A ${onA?.title}, B ${onB?.title}`);
      expect(onB.syncPending === undefined, 'B still has its copy pending');
    });

    await check('Clear history → All time can clear the copy on the account; the other device drops its visits', async () => {
      expect((await dump(b.page, 'history')).some((h) => h.id === 'd1000000-0000-4000-8000-000000000002'), 'device B lacks the visit before the clear');
      await go(a.page, '/history');
      await a.page.getByRole('button', { name: 'Clear history…' }).click();
      const dlg = a.page.getByRole('dialog', { name: 'Clear history' });
      await dlg.getByRole('radio', { name: 'All time' }).check();
      const box = dlg.getByRole('checkbox', { name: 'Also clear the copy on your account' });
      expect(await box.isChecked(), 'the account copy option is not checked by default');
      await dlg.getByRole('button', { name: 'Clear history' }).click();
      await a.page.getByText('Here and on your account. Your other devices remove it when they next sync.').first().waitFor();
      const remote = await api(a.page, '/api/sync/history');
      expect(remote.items.length === 0 && typeof remote.cleared_before === 'number', `server ${JSON.stringify(remote).slice(0, 200)}`);
      await syncNow(b.page);
      await waitFor(async () => !(await dump(b.page, 'history')).some((h) => h.id.startsWith('d1000000')), 'visits gone on device B');
      return `cleared_before ${new Date(remote.cleared_before).toISOString()}`;
    });
  } finally {
    await a.context.close();
    await b.context.close();
  }

  await check('history is not uploaded while account.syncHistory is off', async () => {
    const c = await device(false);
    try {
      const other = `${user}h`;
      await c.page.goto(`${ctx.stack.appOrigin}/settings/account`, { waitUntil: 'networkidle' });
      await c.page.getByRole('button', { name: 'Create one', exact: true }).click();
      await c.page.getByLabel('Username').fill(other);
      await c.page.getByLabel('Password', { exact: true }).fill(password);
      await c.page.getByLabel('Confirm password').fill(password);
      await c.page.getByRole('button', { name: 'Create account' }).last().click();
      await c.page.waitForSelector(`text=${other}`);
      await c.page.waitForTimeout(2500);
      const now = Date.now();
      await seed(c.page, { history: [{ id: 'd2000000-0000-4000-8000-000000000001', url: 'https://example.com/private', title: 'Private', visitedAt: now, syncPending: now }] }, { clear: false });
      await syncNow(c.page);
      const hist = (await api(c.page, '/api/sync/history')).items;
      expect(hist.length === 0, `${hist.length} visits uploaded`);
      expect((await dump(c.page, 'history')).some((h) => h.syncPending !== undefined), 'visit lost its pending flag');
    } finally {
      await c.context.close();
    }
  });
  await browser.close();
}

if (isMain(import.meta.url)) await runStandalone(run, 'library-sync');
