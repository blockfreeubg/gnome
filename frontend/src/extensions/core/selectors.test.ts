// validateSelectors (WAVE-B3 §5.2, §5.4) with a fake stylesheet and a fake clock: what is dropped (invalid, at-rules,
// ::highlight( in any spelling the parser resolves, root and body hits), the ids returned, and the slicing. The real
// parser is exercised in the browsers by rows CS7 and CS14.
import { describe, expect, it } from 'vitest';
import { rootSafeStyle, validateSelectors } from './selectors';
import type { SelectorCheckOptions } from './selectors';

/** Resolves CSS escapes (`\69 ` → `i`, `\:` → `:`) and folds ASCII case in pseudo names, as a browser serializes. */
function serialize(selector: string): string {
  const unescaped = selector.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? '')));
  return unescaped.replace(/(::?)([A-Za-z-]+)/g, (_m, colons: string, name: string) => colons + name.toLowerCase()).trim();
}

/** A stand-in for the browser's CSSStyleSheet: rejects what a real parser rejects in these tests. */
class FakeSheet {
  static made = 0;
  rules: Array<{ selectorText?: string }> = [];
  readonly cssRules = { item: (i: number) => this.rules[i] ?? null };
  constructor() {
    FakeSheet.made++;
  }
  insertRule(rule: string, index = 0): number {
    if (!rule.endsWith('{}')) throw new SyntaxError('not a rule');
    const sel = rule.slice(0, -2);
    if (sel.startsWith('@media')) {
      this.rules.splice(index, 0, {}); // an at-rule: no selectorText
      return index;
    }
    if (sel.trim() === '' || /[{}]|:matches-css|:has-text|:-abp-|^\s*,|,\s*$/.test(sel)) throw new SyntaxError(`invalid selector ${sel}`);
    this.rules.splice(index, 0, { selectorText: serialize(sel) });
    return index;
  }
  deleteRule(index: number): void {
    this.rules.splice(index, 1);
  }
}

const ROOT_HITS = new Set(['html', 'body', ':root', '*', 'body:not(.x)', 'html > body', ':is(html)']);

function options(overrides: Partial<SelectorCheckOptions> = {}): SelectorCheckOptions & { yields: number } {
  const o = {
    CSSStyleSheet: FakeSheet,
    hitsRoot: (s: string) => ROOT_HITS.has(s),
    sliceMs: 8,
    now: () => 0,
    yields: 0,
    async yield() {
      o.yields++;
    },
    ...overrides,
  };
  return o;
}

describe('validateSelectors', () => {
  it('returns the ids of invalid, at-rule, highlight and root/body selectors, keeps the rest', async () => {
    const pairs: Array<[number, string]> = [
      [1, '.ad'],
      [2, '.good,\n.bad {top:0}'],
      [3, 'div:has(> span:matches-css-before(color: red))'],
      [4, '::highlight(gnome-find)'],
      [5, '::HIGHLIGHT(gnome-find)'],
      [6, '::h\\69ghlight(gnome-find)'],
      [7, '*'],
      [8, ':root'],
      [9, 'body:not(.x)'],
      [10, 'body > *'],
      [11, 'html'],
      [12, 'body'],
      [13, '@media screen'],
      [14, 'div[id^="ad-"]'],
      [15, '#banner .x'],
      [16, ''],
    ];
    expect(await validateSelectors(pairs, options())).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 16]);
  });

  it('a throwing hitsRoot drops the selector (fail closed for GNOME UI)', async () => {
    expect(
      await validateSelectors([[1, '.a']], options({
        hitsRoot: () => {
          throw new Error('probe gone');
        },
      })),
    ).toEqual([1]);
  });

  it('cuts the work into slices of at most sliceMs and yields between them', async () => {
    let t = 0;
    const o = options({ now: () => t });
    const pairs: Array<[number, string]> = Array.from({ length: 100 }, (_, i) => [i, `.a${i}`]);
    const seen: number[] = [];
    const sheet = o.CSSStyleSheet;
    o.CSSStyleSheet = class extends (sheet as typeof FakeSheet) {
      override insertRule(rule: string, index?: number): number {
        t += 1; // each selector takes 1 ms
        seen.push(t);
        return super.insertRule(rule, index);
      }
    };
    expect(await validateSelectors(pairs, o)).toEqual([]);
    // 100 ms of work in slices of 8 ms: a yield before the 9th, 17th, … selector
    expect(o.yields).toBe(12);
  });

  it('starts a fresh sheet when a rule could not be deleted, so later reads stay right', async () => {
    FakeSheet.made = 0;
    class Sticky extends FakeSheet {
      override deleteRule(): void {
        throw new Error('no');
      }
    }
    const o = options({ CSSStyleSheet: Sticky });
    expect(await validateSelectors([[1, '.a'], [2, 'body'], [3, '.c']], o)).toEqual([2]);
    expect(FakeSheet.made).toBe(4);
  });

  it('keeps a selector list that the parser accepts as a whole', async () => {
    expect(await validateSelectors([[1, '.a, .b > .c, [data-ad]']], options())).toEqual([]);
  });

  it('drops a selector with a brace, a comment opener or a control character before the parser sees it', async () => {
    // A real parser accepts `div{background:url(x);a:b` + `{}` as ONE rule for `div` (the brace opens the rule's block,
    // EOF closes it; measured by the lane review in Chromium 156 and Firefox 157: selectorText `div`, and the rule's
    // style holds the background). This sheet does the same, so only the text rule can drop it.
    let parsed = 0;
    class Lenient extends FakeSheet {
      override insertRule(rule: string, index = 0): number {
        parsed++;
        this.rules.splice(index, 0, { selectorText: rule.slice(0, rule.indexOf('{')).trim() });
        return index;
      }
    }
    const pairs: Array<[number, string]> = [
      [1, 'div{background:url(//cdn.localhost/beacon);a:b'],
      [2, 'a[title="}"]'],
      [3, 'div/*'],
      [4, 'div\r.ad'],
      [5, '.kept'],
    ];
    expect(await validateSelectors(pairs, options({ CSSStyleSheet: Lenient }))).toEqual([1, 2, 3, 4]);
    expect(parsed).toBe(1);
  });

  it('drops an at-rule that the parser gives a selectorText (`@page :first`), whatever hitsRoot says', async () => {
    // Measured by the lane review (Chromium 156, Firefox 157): insertRule('@page :first{}') makes a CSSPageRule whose
    // selectorText is ':first'. Only a hitsRoot that throws on ':first' dropped it before; this one never matches.
    class PageRules extends FakeSheet {
      override insertRule(rule: string, index = 0): number {
        const sel = rule.slice(0, -2).trim();
        if (sel.startsWith('@page')) {
          this.rules.splice(index, 0, { selectorText: sel.slice(5).trim() });
          return index;
        }
        return super.insertRule(rule, index);
      }
    }
    const pairs: Array<[number, string]> = [
      [1, '@page :first'],
      [2, ' @page :left'],
      [3, '@page'],
      [4, '\\40 page'],
      [5, '.kept'],
    ];
    expect(await validateSelectors(pairs, options({ CSSStyleSheet: PageRules, hitsRoot: () => false }))).toEqual([1, 2, 3]);
  });
});

describe(':style() rules on the root or body (opts.styles)', () => {
  it('keeps a root or body hit whose declarations only restore the page, drops the rest', async () => {
    const pairs: Array<[number, string]> = [
      [1, 'html'],
      [2, 'body'],
      [3, 'body'],
      [4, 'html'],
      [5, 'body'],
      [6, '.not-root'],
      [7, 'body'],
    ];
    const styles = new Map<number, string>([
      [1, 'overflow: auto !important'],
      [2, 'filter: none !important; padding-top: 0'],
      [3, 'display: none !important'],
      [4, 'color: transparent !important; font-size: 0 !important'],
      [6, 'display: none'],
      [7, 'filter: blur(9px)'],
    ]);
    // 5 is a plain hiding rule (no declarations): dropped as before
    expect(await validateSelectors(pairs, options({ styles }))).toEqual([3, 4, 5, 7]);
    // without opts.styles every root or body hit drops (the plan's text)
    expect(await validateSelectors(pairs, options())).toEqual([1, 2, 3, 4, 5, 7]);
  });

  it('rootSafeStyle', () => {
    for (const ok of ['overflow: auto !important', 'overflow:auto!important;', 'overflow-y: auto; overflow-x: hidden', 'background-image:none !important', 'filter: none', 'visibility: visible !important', 'opacity: 1', 'padding-top:0px !important', 'margin-top: 0px', 'cursor: auto', '--topbanner-height:unset!important', 'position: static', 'user-select: text !important', 'height: auto']) {
      expect(rootSafeStyle(ok), ok).toBe(true);
    }
    for (const bad of ['', ';', 'display: none', 'visibility: hidden', 'opacity: 0', 'filter: blur(5px)', 'color: transparent', 'font-size: 0', 'overflow: auto; display: none', 'transform: scale(0)', 'height: 0', 'position: fixed', 'overflow', 'clip-path: inset(50%)', 'content-visibility: hidden']) {
      expect(rootSafeStyle(bad), bad).toBe(false);
    }
  });

  it('rootSafeStyle: margins and paddings only 0 or auto, pointer-events only auto (lane review)', () => {
    // A negative or huge offset moves the whole page off-screen; pointer-events: none makes it unusable.
    for (const ok of ['margin: 0', 'margin: 0 auto', 'margin:0px auto 0 auto', 'padding-top: 0 !important', 'padding-bottom:0px', 'margin-inline-start: auto', 'padding: unset', 'pointer-events: auto !important', 'pointer-events:auto']) {
      expect(rootSafeStyle(ok), ok).toBe(true);
    }
    for (const bad of ['margin-top: -99999px', 'padding-top: 9999px !important', 'margin-left: -100vw', 'margin: 0 0 0 -5000px', 'padding: 50vh 0', 'margin-top: calc(-1 * 100vh)', 'pointer-events: none', 'overflow: auto; pointer-events: none']) {
      expect(rootSafeStyle(bad), bad).toBe(false);
    }
  });
});
