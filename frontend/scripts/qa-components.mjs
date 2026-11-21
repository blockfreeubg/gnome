/**
 * QA scenarios for the design-system components (dev/gallery.html) and performance checks, used by visual-qa.mjs.
 * They need the Vite dev server (the gallery and benchmark pages are not part of the production build).
 *
 *   components    screenshots of the gallery (dark/light, desktop/phone) + structural lint
 *   keyboard      the keyboard path of every interactive component (Select, Combobox, Menu + submenu, context menu,
 *                 Dialog/ConfirmDialog/confirm()/prompt(), Sheet, Popover, Tabs, SegmentedControl, RadioGroup, Switch,
 *                 Checkbox, Slider, ColorPicker, Tooltip, Toast, VirtualList, VirtualGrid, Chip, IconButton)
 *   touch         coarse-pointer phone: every control's hit area is ≥ 40px (DESIGN.md §1.6)
 *   virtualgrid   10,000-card VirtualGrid: mount time, DOM size, frame times while scrolling, jumps, keyboard
 *   layoutshift   cold loads of /, /browse and /games: cumulative layout shift stays below 0.02
 *   motion        prefers-reduced-motion: fades only (no movement during a route change), halved durations; the
 *                 "none" setting stops every transition
 *   a11y          axe-core (WCAG 2.2 A/AA + best practices) on every app screen and on open overlays (palette,
 *                 context menu, dialog, suggestions, submenu, listboxes, toasts) in both themes
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** Runs axe on the current page; returns readable violation lines. */
async function axe(page) {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      rules: { region: { enabled: false } }, // the app shell's landmarks are checked by hand; overlays live outside them
    });
    return r.violations.flatMap((v) =>
      v.nodes.slice(0, 4).map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${(n.failureSummary ?? '').split('\n').slice(1, 2).join('').trim()}`),
    );
  });
}

/** @param {import('playwright-core').Page} page */
async function logIs(page, text, timeout = 3000) {
  await page.waitForFunction((t) => document.querySelector('#log')?.textContent === t, text, { timeout });
}

/** @param {import('playwright-core').Page} page */
function active(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return (a.getAttribute('aria-label') || a.getAttribute('role') || a.tagName.toLowerCase()) + ':' + (a.textContent ?? '').trim().slice(0, 40);
  });
}

export function componentScenarios({ BASE, BROWSER, failures, notes, newPage, shot, lint }) {
  const fail = (msg) => failures.push(msg);
  const check = (cond, msg) => cond || fail(msg);
  const gallery = (theme, extra = '') => `${BASE}/dev/gallery.html?theme=${theme}${extra}`;
  let devPages = null;
  /** The gallery and benchmark pages exist only on the Vite dev server (not in a production build). */
  async function hasDevPages(page) {
    if (devPages === null) {
      const res = await page.request.get(`${BASE}/dev/gallery.html`).catch(() => null);
      devPages = !!res && res.ok() && (await res.text()).includes('gallery.ts');
      if (!devPages) notes.push('dev pages (/dev/gallery.html, /dev/virtual-grid.html) not served: component scenarios skipped');
    }
    return devPages;
  }

  return {
    async components(browser, theme, viewport) {
      const { context, page } = await newPage(browser, { theme, viewport });
      if (!(await hasDevPages(page))) return context.close();
      await page.goto(gallery(theme), { waitUntil: 'networkidle' });
      await page.waitForSelector('#virtual [role="grid"] [role="gridcell"]');
      await lint(page, `${theme}/${viewport} gallery`, viewport === 'phone');
      await shot(page, `components-${theme}-${viewport}`);
      for (const [i, id] of ['#menus', '#display', '#virtual'].entries()) {
        await page.locator(id).scrollIntoViewIfNeeded();
        await shot(page, `components-${theme}-${viewport}-${i + 2}`);
      }
      await context.close();
    },

    async keyboard(browser, theme, viewport) {
      if (viewport === 'phone' || theme === 'light') return;
      const { context, page } = await newPage(browser, { theme, viewport });
      if (!(await hasDevPages(page))) return context.close();
      await page.goto(gallery(theme, '&motion=none'), { waitUntil: 'networkidle' });
      await page.waitForSelector('#virtual [role="grid"] [role="gridcell"]');
      const step = async (name, fn) => {
        try {
          await fn();
        } catch (err) {
          fail(`keyboard ${name}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        }
      };

      await step('select', async () => {
        const trigger = page.getByRole('combobox', { name: 'Search engine' });
        check((await trigger.getAttribute('aria-controls')) === null, 'select: aria-controls points at a closed listbox');
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('[role="listbox"] [role="option"]');
        const controls = await trigger.getAttribute('aria-controls');
        check(!!controls && (await page.$(`#${controls}`)) !== null, 'select: aria-controls does not reference the open listbox');
        check(/DuckDuckGo/.test(await page.locator(`#${await trigger.getAttribute('aria-activedescendant')}`).innerText()), 'select: opens on the selected option');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('End'); // last *enabled* option: "Custom" is disabled
        await page.keyboard.press('Enter');
        await logIs(page, 'select: ecosia');
        check((await page.$(`#${controls}`)) === null, 'select: listbox still open after Enter');
        check((await active(page)).startsWith('combobox'), 'select: focus left the trigger');
        await page.keyboard.press('b'); // typeahead while closed, like a native select
        await logIs(page, 'select: bing');
        await page.keyboard.press('Enter');
        await page.waitForSelector(`#${controls}`);
        await page.keyboard.press('Escape');
        check((await page.$(`#${controls}`)) === null, 'select: Escape did not close');
        await logIs(page, 'select: bing'); // Escape changes nothing
      });

      await step('combobox', async () => {
        const input = page.getByRole('combobox', { name: 'Country' });
        await input.focus();
        await page.keyboard.type('swe');
        await page.waitForSelector('[role="listbox"] [role="option"]:has-text("Sweden")');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await logIs(page, 'combobox: Sweden');
        await page.keyboard.press('Control+A');
        await page.keyboard.type('zz');
        await page.waitForSelector('text=No matching country.');
        await page.keyboard.press('Escape');
        check((await page.$('text=No matching country.')) === null, 'combobox: Escape did not close the popup');
        await page.keyboard.press('Enter');
        await logIs(page, 'combobox submit: zz');
      });

      await step('menu', async () => {
        const trigger = page.getByRole('button', { name: 'File actions' });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="menu"]');
        check((await active(page)).startsWith('menuitem:Rename'), `menu: first item not focused (${await active(page)})`);
        check((await page.getAttribute('[role="menuitem"]:has-text("Rename")', 'aria-keyshortcuts')) === 'Alt+R', 'menu: aria-keyshortcuts not in ARIA syntax');
        check((await page.getAttribute('[role="menuitem"]:has-text("Duplicate")', 'aria-keyshortcuts')) === 'Alt+Shift+D', 'menu: action shortcut not resolved for aria-keyshortcuts');
        await page.keyboard.press('End');
        check((await active(page)).includes('Delete'), 'menu: End does not reach the last item');
        await page.keyboard.press('Home');
        await page.keyboard.press('m'); // typeahead
        check((await active(page)).includes('Move to'), `menu: typeahead (${await active(page)})`);
        await page.keyboard.press('ArrowRight');
        await page.waitForSelector('[role="menu"] >> nth=1');
        check((await active(page)).includes('Inbox'), 'menu: ArrowRight does not open the submenu on its first item');
        await page.keyboard.press('ArrowLeft');
        check((await active(page)).includes('Move to'), 'menu: ArrowLeft does not return to the parent item');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await logIs(page, 'menu: move=Projects');
        check((await page.$('[role="menu"]')) === null, 'menu: still open after choosing');
        check((await active(page)).includes('File actions'), 'menu: focus not returned to the trigger');
        await page.keyboard.press('ArrowUp'); // opens on the last item
        await page.waitForSelector('[role="menu"]');
        check((await active(page)).includes('Delete'), 'menu: ArrowUp does not open on the last item');
        await page.keyboard.press('Home');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown'); // Rename → Duplicate → Archive (disabled) → checkbox
        await page.keyboard.press(' ');
        await logIs(page, 'menu: hidden=true');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="menuitemcheckbox"][aria-checked="true"]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="menu"]', { state: 'detached' });
        check((await active(page)).includes('File actions'), 'menu: Escape did not restore focus');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="menu"]');
        await page.keyboard.press('Tab');
        await page.waitForSelector('[role="menu"]', { state: 'detached' });
      });

      await step('context menu', async () => {
        const area = page.getByRole('button', { name: /context menu/ });
        await area.focus();
        if (BROWSER === 'chromium') await page.keyboard.press('Shift+F10');
        else await area.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })));
        await page.waitForSelector('[role="menu"][aria-label="Item actions"]');
        check((await active(page)).includes('Open'), 'context menu: first item not focused from the keyboard');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await logIs(page, 'context: Copy link');
        check((await active(page)).includes('Right-click here'), 'context menu: focus not restored');
      });

      await step('dialog', async () => {
        await page.getByRole('button', { name: 'Dialog', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog.dialog[open] .panel');
        const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'));
        check(await inDialog(), 'dialog: focus not moved into the dialog');
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Tab');
          check(await inDialog(), `dialog: Tab #${i + 1} left the dialog`);
        }
        await page.keyboard.press('Shift+Tab');
        check(await inDialog(), 'dialog: Shift+Tab left the dialog');
        await page.keyboard.press('Escape');
        await logIs(page, 'dialog: closed');
        await page.waitForSelector('dialog.dialog[open]', { state: 'detached', timeout: 2000 }).catch(() => undefined);
        check((await active(page)).includes('Dialog'), `dialog: focus not restored (${await active(page)})`);
      });

      // A toast raised while a modal dialog is open must be above it and usable (the rest of the page is inert).
      await step('toast over dialog', async () => {
        await page.getByRole('button', { name: 'Dialog', exact: true }).click();
        await page.waitForSelector('dialog.dialog[open] .panel');
        await page.getByRole('button', { name: 'Error toast over this dialog' }).click();
        const action = page.locator('.toast-layer').getByRole('button', { name: 'Try again' });
        await action.waitFor();
        const placed = await page.evaluate(() => {
          const layer = document.querySelector('.toast-layer');
          const btn = [...(layer?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Try again');
          if (!layer || !btn) return 'missing';
          const r = btn.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!layer.closest('dialog[open]')) return 'not inside the open dialog';
          return btn === hit || btn.contains(hit) ? 'ok' : `covered by ${hit?.tagName.toLowerCase()}.${hit?.className}`;
        });
        check(placed === 'ok', `toast over dialog: not on top or not usable (${placed})`);
        await action.click();
        await logIs(page, 'toast: retry over dialog');
        await page.keyboard.press('Escape');
        await page.waitForSelector('dialog.dialog[open]', { state: 'detached', timeout: 2000 }).catch(() => undefined);
        check(
          await page.evaluate(() => document.querySelector('.toast-layer')?.parentElement === document.body),
          'toast over dialog: the stack did not return to <body> after the dialog closed',
        );
      });

      await step('confirm dialog', async () => {
        await page.getByRole('button', { name: 'Confirm dialog' }).click();
        await page.waitForSelector('dialog[role="alertdialog"][open] [data-cancel]');
        await page.waitForTimeout(50);
        check((await active(page)).includes('Cancel'), `confirm dialog: a danger confirmation must focus Cancel (${await active(page)})`);
        await page.keyboard.press('Escape');
        await logIs(page, 'confirmdialog: cancelled');
      });

      await step('confirm()', async () => {
        await page.getByRole('button', { name: 'confirm()' }).click();
        await page.waitForSelector('dialog[open] [data-confirm]');
        await page.waitForTimeout(50);
        check((await active(page)).includes('Cancel'), 'confirm(): danger focuses Cancel');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await logIs(page, 'confirm: true');
      });

      await step('prompt()', async () => {
        await page.getByRole('button', { name: 'prompt()' }).click();
        await page.waitForSelector('dialog[open] input');
        await page.waitForTimeout(50);
        check((await active(page)).startsWith('input'), 'prompt(): input not focused');
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog[open] :text("Enter a name.")');
        await page.keyboard.type('Docs');
        await page.keyboard.press('Enter');
        await logIs(page, 'prompt: Docs');
      });

      await step('sheet', async () => {
        await page.getByRole('button', { name: 'Side sheet' }).focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog.sheet[open] .panel');
        check(await page.evaluate(() => !!document.activeElement?.closest('dialog.sheet[open]')), 'sheet: focus not in the sheet');
        await page.keyboard.press('Escape');
        await logIs(page, 'sheet: closed');
        await page.waitForTimeout(450);
        check((await active(page)).includes('Side sheet'), 'sheet: focus not restored');
      });

      await step('popover', async () => {
        const trigger = page.getByRole('button', { name: 'Popover' });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="dialog"][aria-label="Quick rename"]');
        await page.waitForTimeout(50);
        check(await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Quick rename"]')), 'popover: focus not moved in');
        await page.keyboard.press('Escape');
        await logIs(page, 'popover: closed');
        check((await active(page)).includes('Popover'), 'popover: focus not returned to the anchor');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="dialog"][aria-label="Quick rename"]');
        await page.waitForTimeout(50);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab'); // past "Save": focus leaves the popover → it closes
        await page.waitForSelector('[role="dialog"][aria-label="Quick rename"]', { state: 'detached', timeout: 2000 });
      });

      await step('tabs', async () => {
        await page.getByRole('tab', { name: 'General' }).focus();
        await page.keyboard.press('ArrowRight');
        await logIs(page, 'tabs: privacy');
        await page.keyboard.press('End');
        await logIs(page, 'tabs: advanced');
        await page.keyboard.press('Home');
        await logIs(page, 'tabs: general');
        await page.keyboard.press('Tab');
        check((await active(page)).startsWith('tabpanel'), 'tabs: Tab does not move into the panel');
      });

      await step('segmented control', async () => {
        await page.getByRole('radio', { name: 'Dark' }).focus();
        await page.keyboard.press('ArrowRight');
        await logIs(page, 'theme: light');
        check(await page.evaluate(() => document.documentElement.classList.contains('theme-light')), 'segmented: theme not applied');
        await page.keyboard.press('ArrowLeft');
        await logIs(page, 'theme: dark');
      });

      await step('radio group', async () => {
        await page.getByRole('radio', { name: /Comfortable/ }).focus();
        await page.keyboard.press('ArrowDown');
        await logIs(page, 'radio: spacious');
      });

      await step('switch + checkbox', async () => {
        await page.getByRole('switch', { name: 'Wi-Fi only' }).first().focus();
        await page.keyboard.press(' ');
        await logIs(page, 'switch: false');
        await page.keyboard.press('Enter');
        await logIs(page, 'switch: true');
        await page.getByRole('checkbox', { name: 'I read the terms' }).focus();
        await page.keyboard.press(' ');
        await logIs(page, 'checkbox: true');
        const all = page.getByRole('checkbox', { name: 'Select all rows' });
        check(await all.evaluate((el) => el.indeterminate), 'checkbox: indeterminate not set');
        await all.focus();
        await page.keyboard.press(' ');
        await logIs(page, 'checkbox all: true');
        check(!(await all.evaluate((el) => el.indeterminate)), 'checkbox: still indeterminate after toggling');
      });

      await step('slider', async () => {
        const slider = page.getByRole('slider', { name: 'Font size' });
        await slider.focus();
        await page.keyboard.press('ArrowRight');
        await logIs(page, 'slider: 15');
        await page.keyboard.press('End');
        await logIs(page, 'slider: 20');
        check((await slider.getAttribute('aria-valuetext')) === '20 px', 'slider: aria-valuetext');
        await page.keyboard.press('Home');
        await logIs(page, 'slider: 12');
      });

      await step('color picker', async () => {
        await page.getByRole('radio', { name: 'Wheat' }).focus();
        await page.keyboard.press('ArrowRight');
        // Preset values: ACCENT_PRESETS in src/settings/apply.ts (design v2 re-tuned the earth tones).
        await logIs(page, 'color: #b7cb8c moss');
        check((await active(page)).startsWith('Moss'), 'color: focus does not follow the selection');
        await page.keyboard.press('End');
        await logIs(page, 'color: #86caa7 fern');
        const hex = page.getByRole('textbox', { name: 'Hex color' });
        await hex.fill('#12');
        await hex.press('Enter');
        await page.waitForSelector(':text("Use a hex color like #9ff0c8.")');
        await hex.fill('#123456');
        await hex.press('Enter');
        await logIs(page, 'color: #123456 custom');
        // With a custom color no swatch is selected: the roving tab stop is on the first preset (Mint in design v2).
        check((await page.$('[role="radio"][aria-label="Mint"][tabindex="0"]')) !== null, 'color: roving tabindex lost with a custom color');
      });

      await step('tooltip', async () => {
        const btn = page.getByRole('button', { name: 'Search' }).first();
        await page.getByRole('link', { name: 'Link to tabs' }).focus();
        await page.keyboard.press('Tab'); // keyboard focus → tooltip shows at once
        check((await active(page)).startsWith('Search'), 'tooltip: Tab order');
        await page.waitForSelector('[role="tooltip"]:has-text("Search")', { timeout: 1500 });
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="tooltip"]', { state: 'detached', timeout: 1500 });
        // Hover: shows after the delay, stays while the pointer moves onto it, Escape works with focus elsewhere.
        await page.getByRole('heading', { name: 'Components' }).focus();
        const box = await btn.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const tip = await page.waitForSelector('[role="tooltip"]', { timeout: 1500 });
        const tb = await tip.boundingBox();
        await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 4 });
        await page.waitForTimeout(250);
        check((await page.$('[role="tooltip"]')) !== null, 'tooltip: not hoverable (disappears when the pointer moves onto it)');
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="tooltip"]', { state: 'detached', timeout: 1500 });
        await page.mouse.move(5, 5);
      });

      await step('toast', async () => {
        await page.getByRole('button', { name: 'Error toast' }).click();
        const retry = page.getByRole('button', { name: 'Retry' });
        await retry.waitFor();
        await retry.focus();
        await page.keyboard.press('Enter');
        await logIs(page, 'toast: retry');
      });

      await step('icon button + chips', async () => {
        const pin = page.getByRole('button', { name: 'Pin tab' });
        await pin.focus();
        await page.keyboard.press('Enter');
        await logIs(page, 'iconbutton: pinned=true');
        check((await pin.getAttribute('aria-pressed')) === 'true', 'iconbutton: aria-pressed not set');
        await page.getByRole('button', { name: 'Saving' }).click({ force: true }); // aria-disabled while loading
        await page.getByRole('button', { name: 'Disabled' }).click({ force: true });
        check(!/loading clicked|disabled clicked/.test(await page.locator('#log').innerText()), 'button: loading/disabled buttons ran their handler');
        const chip = page.getByRole('button', { name: 'Action', exact: true });
        await chip.focus();
        await page.keyboard.press('Enter');
        await logIs(page, 'chip: false');
        await page.getByRole('button', { name: 'Remove filter: Mobile' }).focus();
        await page.keyboard.press('Enter');
        await logIs(page, 'chip: removed');
      });

      await step('virtual list', async () => {
        const list = page.getByRole('listbox', { name: 'Visits' });
        await list.focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('End');
        await page.waitForSelector('[role="option"]:has-text("Visit 10000")');
        await page.keyboard.press('Enter');
        await logIs(page, 'vlist: Visit 10000');
        const rendered = await page.locator('[role="listbox"][aria-label="Visits"] [role="option"]').count();
        check(rendered < 60, `virtual list: ${rendered} rows in the DOM for 10,000 items`);
        const id = await list.getAttribute('aria-activedescendant');
        check(!!id && (await page.$(`#${id}`)) !== null, 'virtual list: aria-activedescendant points at a missing row');
      });

      await step('virtual grid', async () => {
        const grid = page.getByRole('grid', { name: 'Games' });
        await grid.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Control+End');
        await page.waitForSelector('[role="grid"][aria-label="Games"] [role="gridcell"]:has-text("Game 2000")');
        await page.keyboard.press('Enter');
        await logIs(page, 'vgrid: Game 2000');
        await page.keyboard.press('Control+Home');
        await page.keyboard.press('Enter');
        await logIs(page, 'vgrid: Game 1');
      });

      await context.close();
    },

    async touch(browser, theme, viewport) {
      if (viewport !== 'phone' || theme === 'light') return;
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: BROWSER === 'chromium', deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on('pageerror', (e) => fail(`touch: page error: ${e.message}`));
      if (!(await hasDevPages(page))) return context.close();
      await page.goto(gallery(theme, '&motion=none'), { waitUntil: 'networkidle' });
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      if (!coarse) {
        notes.push('touch: this browser emulation does not report (pointer: coarse); skipped');
        await context.close();
        return;
      }
      const small = await page.evaluate(() => {
        const out = [];
        const sel = 'button, a[href], input[type="checkbox"], input[type="radio"], [role="switch"], [role="tab"], [role="radio"]';
        for (const el of document.querySelectorAll(sel)) {
          if (el.closest('[aria-hidden="true"], [inert]') || el.getClientRects().length === 0) continue;
          // The element's own box, grown by its hit-area pseudo-element (::after) or its label wrapper.
          const r = el.getBoundingClientRect();
          let w = r.width;
          let h = r.height;
          for (const host of [el, el.closest('label'), el.closest('.box-wrap')].filter(Boolean)) {
            const hr = host.getBoundingClientRect();
            w = Math.max(w, hr.width);
            h = Math.max(h, hr.height);
            const after = getComputedStyle(host, '::after');
            if (after.content !== 'none' && after.position === 'absolute') {
              w = Math.max(w, hr.width - parseFloat(after.left) - parseFloat(after.right));
              h = Math.max(h, hr.height - parseFloat(after.top) - parseFloat(after.bottom));
            }
          }
          const box = el.closest('.box-wrap') ?? el.parentElement?.querySelector('.box-wrap');
          if (box) {
            const after = getComputedStyle(box, '::after');
            const br = box.getBoundingClientRect();
            w = Math.max(w, br.width - parseFloat(after.left) - parseFloat(after.right));
            h = Math.max(h, br.height - parseFloat(after.top) - parseFloat(after.bottom));
          }
          if (Math.min(w, h) < 39.5) out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24)}] ${Math.round(w)}×${Math.round(h)}`);
        }
        return out;
      });
      for (const s of small) fail(`touch: hit area under 40px: ${s}`);
      await page.getByRole('button', { name: 'File actions' }).tap();
      await page.waitForSelector('[role="menu"]');
      const itemH = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) => Math.min(...els.map((e) => e.getBoundingClientRect().height)));
      check(itemH >= 39.5, `touch: menu items are ${itemH}px tall`);
      await context.close();
    },

    async virtualgrid(browser, theme, viewport) {
      if (viewport === 'phone' || theme === 'light') return;
      const { context, page } = await newPage(browser, { theme, viewport });
      if (!(await hasDevPages(page))) return context.close();
      await page.goto(`${BASE}/dev/virtual-grid.html?count=10000`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.__bench);
      const r = await page.evaluate(async () => {
        const bench = window.__bench;
        const scroller = bench.scroller;
        const cells = () => document.querySelectorAll('[role="gridcell"]').length;
        const long = [];
        if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
          new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(Math.round(e.duration)))).observe({ type: 'long-animation-frame' });
        }
        const frames = [];
        let maxCells = cells();
        const raf = () => new Promise((res) => requestAnimationFrame(res));
        await raf();
        let prev = performance.now();
        const end = scroller.scrollHeight - scroller.clientHeight;
        // ~2,400 px/s (40 px per frame): a fast flick-scroll through the catalog, measuring every frame.
        for (let i = 0; i < 300 && scroller.scrollTop < end; i++) {
          scroller.scrollTop += 40;
          await raf();
          const now = performance.now();
          frames.push(now - prev);
          prev = now;
          maxCells = Math.max(maxCells, cells());
        }
        frames.sort((a, b) => a - b);
        const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
        // Jump to the end: the last card must be rendered within two frames.
        scroller.scrollTop = scroller.scrollHeight;
        await raf();
        await raf();
        const lastShown = [...document.querySelectorAll('[role="gridcell"]')].some((c) => c.textContent.includes('Game 10000'));
        return {
          mountMs: Math.round(bench.mountMs),
          maxCells,
          frames: frames.length,
          p50: +pct(0.5).toFixed(1),
          p95: +pct(0.95).toFixed(1),
          max: +frames[frames.length - 1].toFixed(1),
          over33: frames.filter((f) => f > 33.4).length,
          longFrames: long,
          lastShown,
          height: scroller.scrollHeight,
        };
      });
      notes.push(`virtualgrid 10,000 cards: mount ${r.mountMs} ms, ≤ ${r.maxCells} cells in the DOM, ${r.frames} scroll frames p50 ${r.p50} ms / p95 ${r.p95} ms / max ${r.max} ms, ${r.over33} over 33 ms, long animation frames ${JSON.stringify(r.longFrames)}`);
      check(r.mountMs < 300, `virtualgrid: mount took ${r.mountMs} ms`);
      check(r.maxCells <= 120, `virtualgrid: ${r.maxCells} cells rendered at once`);
      check(r.p95 <= 25, `virtualgrid: p95 frame time ${r.p95} ms while scrolling`);
      check(r.over33 <= Math.ceil(r.frames * 0.02), `virtualgrid: ${r.over33} of ${r.frames} frames over 33 ms`);
      check(r.lastShown, 'virtualgrid: the last card is not rendered after jumping to the end');
      // Keyboard: Ctrl+Home, then PageDown moves by a screen and keeps the active card visible.
      const grid = page.getByRole('grid', { name: 'Games' });
      await grid.focus();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('PageDown');
      await page.keyboard.press('PageDown');
      const visible = await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); // rows follow the scroll
        const id = document.querySelector('[role="grid"]').getAttribute('aria-activedescendant');
        const cell = id && document.getElementById(id);
        if (!cell) return false;
        const r = cell.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      check(visible, 'virtualgrid: PageDown moved the active card out of view');
      await page.keyboard.press('Enter');
      check(/Game \d+/.test(await page.locator('#activated').innerText()), 'virtualgrid: Enter did not activate the card');
      await context.close();
    },

    async a11y(browser, theme, viewport) {
      const report = (label, lines) => lines.forEach((l) => fail(`a11y ${theme}/${viewport} ${label}: ${l}`));
      // axe is injected as an inline script, which the server's Content-Security-Policy rightly blocks.
      const contextOptions = { bypassCSP: true };
      const { context, page } = await newPage(browser, { theme, viewport, contextOptions });
      for (const path of ['/', '/games', '/browse', '/settings', '/about', '/history', '/no-such-page']) {
        await page.goto(BASE + path, { waitUntil: 'networkidle' });
        await page.waitForTimeout(250);
        report(path, await axe(page));
      }
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.keyboard.press('Control+K');
      await page.waitForSelector('dialog.palette[open] [role="option"]');
      await page.waitForTimeout(250);
      report('palette', await axe(page));
      await page.keyboard.press('Escape');
      await page.locator('.tiles .tile').first().click({ button: 'right' });
      await page.waitForSelector('[role="menu"]');
      report('context menu', await axe(page));
      await page.keyboard.press('Escape');
      await page.getByRole('combobox', { name: 'Search or enter address' }).fill('wiki');
      await page.waitForTimeout(250);
      report('home suggestions', await axe(page));
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Add link' }).click();
      await page.waitForSelector('dialog.dialog[open] input');
      await page.waitForTimeout(300);
      report('dialog', await axe(page));
      await context.close();

      const g = await newPage(browser, { theme, viewport, contextOptions });
      if (!(await hasDevPages(g.page))) return g.context.close();
      await g.page.goto(gallery(theme, '&motion=none'), { waitUntil: 'networkidle' });
      report('gallery', await axe(g.page));
      await g.page.getByRole('button', { name: 'File actions' }).click();
      await g.page.getByRole('menuitem', { name: 'Move to' }).hover();
      await g.page.waitForSelector('[role="menu"] >> nth=1');
      report('gallery submenu', await axe(g.page));
      await g.page.keyboard.press('Escape');
      await g.page.keyboard.press('Escape');
      await g.page.getByRole('combobox', { name: 'Search engine' }).click();
      report('gallery select', await axe(g.page));
      await g.page.keyboard.press('Escape');
      await g.page.getByRole('combobox', { name: 'Country' }).fill('s');
      report('gallery combobox', await axe(g.page));
      await g.page.keyboard.press('Escape');
      await g.page.getByRole('button', { name: 'Error toast' }).click();
      await g.page.waitForSelector('.toast');
      report('gallery toast', await axe(g.page));
      await g.context.close();
    },

    async motion(browser, theme, viewport) {
      if (viewport === 'phone' || theme === 'light') return;
      const { context, page } = await newPage(browser, { theme, viewport, contextOptions: { reducedMotion: 'reduce' } });
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      const env = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return { cls: document.documentElement.className, motion: cs.getPropertyValue('--motion').trim(), move: cs.getPropertyValue('--motion-move').trim() };
      });
      check(env.cls.includes('motion-reduced') && env.motion === '0.5' && env.move === '0', `motion: reduced motion not applied (${JSON.stringify(env)})`);
      // During a route change nothing may move (cross-fade only): sample transforms of the stage and the page.
      const moved = await page.evaluate(async () => {
        const seen = new Set();
        let stop = false;
        const still = (t) => !t || t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
        const sample = () => {
          // The View Transitions route animation runs on pseudo-elements; the fallback cross-fade on .route.
          for (const pe of ['::view-transition-new(gnome-page)', '::view-transition-old(gnome-page)']) {
            const t = getComputedStyle(document.documentElement, pe).transform;
            if (!still(t)) seen.add(`${pe} ${t}`);
          }
          for (const el of [document.querySelector('.stage'), ...document.querySelectorAll('.route')]) {
            const t = el ? getComputedStyle(el).transform : 'none';
            if (!still(t)) seen.add(`${el.className} ${t}`);
          }
          if (!stop) requestAnimationFrame(sample);
        };
        sample();
        document.querySelector('nav.rail a[href="/games"]').click();
        await new Promise((r) => setTimeout(r, 400));
        stop = true;
        return [...seen];
      });
      check(moved.length === 0, `motion: elements moved during a reduced-motion route change: ${moved.join(' ')}`);
      await context.close();
    },

    async layoutshift(browser, theme, viewport) {
      if (theme === 'light' || BROWSER !== 'chromium') return; // the Layout Instability API is Chromium-only
      for (const path of ['/', '/browse', '/games']) {
        const { context, page } = await newPage(browser, { theme, viewport });
        await context.addInitScript(() => {
          window.__cls = 0;
          window.__shifts = [];
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (e.hadRecentInput) continue;
              window.__cls += e.value;
              window.__shifts.push(`${e.value.toFixed(3)}@${Math.round(e.startTime)}ms ${(e.sources ?? []).map((s) => s.node?.className ?? '?').join(',')}`);
            }
          }).observe({ type: 'layout-shift', buffered: true });
        });
        await page.goto(BASE + path, { waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        const { cls, shifts } = await page.evaluate(() => ({ cls: window.__cls, shifts: window.__shifts }));
        check(cls < 0.02, `layoutshift ${viewport} ${path}: CLS ${cls.toFixed(3)} (${shifts.join(' | ')})`);
        await context.close();
      }
    },
  };
}
