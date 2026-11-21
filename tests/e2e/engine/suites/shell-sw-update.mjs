// Lane c (browser shell), real stack: the "GNOME was updated" notice with a really waiting service worker
// (ENGINE-PROTOCOL §2.5). Two GNOME tabs run engine hosts of one build; gnome-server is restarted with a second
// build (another build id, so another /sw.js); one tab restarts its browser engine, whose engine host installs the
// new worker, which waits because the other tab's engine host still uses the old one. The app must show the notice
// asking to close the other GNOME tab; after closing it, Reload applies the update and the notice is gone.
//
//   cd tests/e2e && E2E_PORT_BASE=28100 node engine/run.mjs --only shell-sw-update
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND_DIR } from '../lib/config.mjs';
import { omnibox, openGnome, state, waitLoaded, waitState } from './shell-lib.mjs';

const EXAMPLE = /^https:\/\/example\.com\/?$/;

function build(dist, buildId) {
  return new Promise((resolve, reject) => {
    const p = spawn('npm', ['run', 'build:e2e'], { cwd: FRONTEND_DIR, env: { ...process.env, GNOME_DIST_DIR: dist, GNOME_BUILD_ID: buildId }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code}): ${out.slice(-1500)}`))));
  });
}

export async function run(ctx) {
  const rec = (test, ok, notes) => ctx.record({ test: `shell-sw-update: ${test}`, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes)?.slice(0, 700) });
  const dist2 = path.join(ctx.runDir, `dist-update-${ctx.browser}`);
  const buildId = `e2e-update-${ctx.browser}-${Date.now().toString(36)}`;
  await build(dist2, buildId);
  if (!existsSync(path.join(dist2, 'sw.js'))) {
    rec('second build', false, 'no sw.js in the second build');
    return;
  }
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    const a = await openGnome(ctx, context);
    await waitState(a.page, (s) => s.tabs.length === 1, 15_000, 'tab A');
    await omnibox(a.page, 'example.com');
    await waitLoaded(a.page, EXAMPLE, 60_000);
    const b = await openGnome(ctx, context);
    await waitState(b.page, (s) => s.tabs.length >= 1, 15_000, 'tab B');
    await omnibox(b.page, 'example.com');
    await waitLoaded(b.page, EXAMPLE, 60_000);
    rec('two GNOME tabs browse with the first build', true, '');

    await ctx.stack.restartServer({ GNOME_STATIC_DIR: dist2 });
    await a.page.getByRole('button', { name: 'Browser menu' }).click();
    await a.page.getByRole('menuitem', { name: 'Restart browser engine' }).click();
    const s = await waitState(a.page, (x) => x.updateNotice === true, 45_000, 'update notice').catch((e) => ({ err: String(e) }));
    ctx.log(`sw status with two engine hosts: ${JSON.stringify(s.sw ?? s.err)}`);
    // The notice counts the other GNOME pages first (a ping on the app-origin channel).
    const notice = a.page.getByText(/GNOME was updated/);
    let text = '';
    for (let i = 0; i < 25 && !/Close the other/.test(text); i++) {
      text = (await notice.textContent({ timeout: 5000 }).catch(() => null)) ?? '';
      if (!/Close the other/.test(text)) await a.page.waitForTimeout(200);
    }
    rec('a waiting service worker shows "GNOME was updated" and asks to close the other GNOME tab', !s.err && /Close the other GNOME tabs \(1\)/.test(text), { text, err: s.err });

    await b.page.close();
    await a.page.locator('.notices').getByRole('button', { name: 'Reload' }).click();
    await a.page.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 30_000 });
    const after = await waitLoaded(a.page, EXAMPLE, 60_000);
    const final = await waitState(a.page, (x) => x.updateNotice === false, 20_000, 'no update notice').catch(async () => state(a.page));
    rec('with the other tab closed, Reload applies the update (no notice afterwards)', final.updateNotice === false && after.engineState === 'ready', { updateNotice: final.updateNotice, sw: final.sw });
    await context.close();
  } finally {
    await ctx.stack.restartServer({}).catch(() => {});
    await browser.close();
  }
}
