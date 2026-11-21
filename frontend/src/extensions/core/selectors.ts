/**
 * Cosmetic selector validation (WAVE-B3 §5.1, §5.2, D8, §11.5). A list built without a DOM (lane x1's Worker) keeps
 * selectors the browser rejects, and one invalid selector disables the whole 1,024-selector rule it lands in (research
 * §2.8). Lane x1's build sends every selector that reaches a stylesheet (plain hiding rules and the selectors of
 * `:style()` rules) here, on the engine host's main thread, and removes the ids this returns from the engines.
 *
 * Each selector is parsed by the browser's own stylesheet parser (`insertRule(selector + '{}')` into a sheet of the
 * engine-host realm that is never attached to a document) and dropped when:
 *  - its text has a brace, a comment opener or a control character (sanitize.ts `isSafeSelectorText`, checked first):
 *    the parser accepts `div{background:url(//x);a:b` + `{}` as one rule for `div`, but in the library's stylesheet
 *    text that brace opens a block of the list's own declarations (lane review, 2026-11-19);
 *  - it does not parse, or does not parse as one style rule: `@media x` + `{}` is an at-rule, and so is anything
 *    whose text starts with `@` (no selector does), also `@page :first`, which the parser accepts with a
 *    `selectorText` of `:first` (measured in Chromium 156 and Firefox 157 by the lane review, 2026-11-20); in the
 *    library's stylesheet text it would turn its whole 1,024-selector rule into an invalid `@page` rule;
 *  - the selector as the browser serialized it (escapes resolved, names folded) contains `::highlight(`: find-in-page
 *    highlights are GNOME's UI inside proxied pages;
 *  - it matches the root or body element of a probe document (`opts.hitsRoot`: `html`, `body`, `:root`, `*`,
 *    `body:not(.x)`), so a generic rule such as `##body` or `##*` cannot blank every page. A rule that hides the root
 *    only under a condition the empty probe document does not meet (`html[lang]`, `body:has(div)`) is not caught, and
 *    hiding everything inside the body (`body > *`) stays possible: what a list hides belongs to the site, and the
 *    operator chose the list (WAVE-B3 §11.5).
 *
 * `:style()` rules on the root or body (adapted from the plan, measured 2026-11-19): 103 of the 104 root/body rules of
 * the default lists are `:style()` unbreak fixes that undo what anti-adblock walls do to a page (`html,body:style(
 * overflow: auto !important)` 60 times, `background-image: none`, `filter: none`, `padding-top: 0`, `opacity: 1`);
 * dropping them leaves pages scroll-locked. When the caller names a rule's declarations in `opts.styles`, a root or
 * body hit is kept if every declaration only restores the page (`rootSafeStyle`): none can hide it, make it
 * transparent, or move its content away (margins and paddings only 0 or auto: the lane review measured those as the
 * only values of the default lists' 103 rules, 2026-11-20); without `opts.styles` every root or body hit is dropped,
 * as the plan's text says.
 *
 * The work is cut into slices of at most `opts.sliceMs` with `opts.yield()` between them, so the app's main thread
 * (shared with the engine host) never sees a long task from it. The constructor is passed in, so this file compiles
 * without the DOM lib (the core compiles in every scope).
 */
import { isSafeSelectorText } from './sanitize';

export interface SelectorCheckOptions {
  CSSStyleSheet: new () => {
    insertRule(rule: string, index?: number): number;
    deleteRule(index: number): void;
    readonly cssRules: { item(index: number): { readonly selectorText?: string } | null };
  };
  /** Whether a selector (as the sheet serialized it) matches the html or body element of a probe document. */
  hitsRoot(selectorText: string): boolean;
  /** Longest synchronous slice (8). */
  sliceMs: number;
  now(): number;
  /** Gives the main thread back between slices (scheduler.yield where available, else setTimeout 0). */
  yield(): Promise<void>;
  /**
   * Optional (an addition to WAVE-B3 §5.2): the `:style()` declarations of the ids that are `:style()` rules. A root or
   * body hit of such a rule is kept when `rootSafeStyle` accepts its declarations. Absent: every root or body hit drops.
   */
  styles?: ReadonlyMap<number, string>;
}

/** Properties a root or body `:style()` rule may set with any (isSafeStyle-checked) value: they cannot blank a page. */
const ROOT_SAFE_PROP_RE = /^(?:overflow(?:-x|-y)?|overscroll-behavior(?:-x|-y)?|cursor|(?:-webkit-|-moz-)?user-select|touch-action|background(?:-image|-color|-attachment)?|scroll-behavior|--[a-z0-9_-]+)$/;
/**
 * Margins and paddings only with values that undo a wall's offset (a negative or huge one would move the content
 * off-screen): `0`, `0px` or `auto`, one to four of them, or `unset`/`initial` (lane review, 2026-11-20).
 */
const ROOT_BOX_PROP_RE = /^(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$/;
const ROOT_BOX_VALUE_RE = /^(?:(?:0|0px|auto)(?:\s+(?:0|0px|auto)){0,3}|unset|initial)$/;
/** Properties allowed only with a value that restores visibility (or, for pointer-events, interaction). */
const ROOT_RESTORE: Readonly<Record<string, RegExp>> = {
  'pointer-events': /^(?:auto|unset|initial)$/,
  filter: /^(?:none|unset|initial)$/,
  '-webkit-filter': /^(?:none|unset|initial)$/,
  'backdrop-filter': /^(?:none|unset|initial)$/,
  visibility: /^(?:visible|unset|initial)$/,
  opacity: /^(?:1|1\.0+|unset|initial)$/,
  position: /^(?:static|relative|unset|initial)$/,
  height: /^(?:auto|unset|initial)$/,
  'max-height': /^(?:none|unset|initial)$/,
};

/**
 * Whether `:style()` declarations (already accepted by sanitize.ts isSafeStyle: no braces, comments or escapes) only
 * restore a page: every declaration's property is in ROOT_SAFE_PROP_RE, or in ROOT_RESTORE with its restoring value.
 */
export function rootSafeStyle(declarations: string): boolean {
  let any = false;
  for (const raw of declarations.split(';')) {
    const d = raw.trim();
    if (d.length === 0) continue;
    const colon = d.indexOf(':');
    if (colon <= 0) return false;
    const prop = asciiLower(d.slice(0, colon).trim());
    const value = asciiLower(d.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim());
    if (value.length === 0) return false;
    const restore = ROOT_RESTORE[prop] ?? (ROOT_BOX_PROP_RE.test(prop) ? ROOT_BOX_VALUE_RE : undefined);
    if (restore ? !restore.test(value) : !ROOT_SAFE_PROP_RE.test(prop)) return false;
    any = true;
  }
  return any;
}

/** ASCII lowercase only (CSS folds A–Z and nothing else). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** One selector's verdict: true = drop. `style`: the rule's `:style()` declarations, when the caller named them. */
function rejects(sheet: InstanceType<SelectorCheckOptions['CSSStyleSheet']>, selector: string, opts: SelectorCheckOptions, style: string | undefined): boolean {
  if (!isSafeSelectorText(selector)) return true;
  // An at-rule, whatever the parser makes of it (`@page :first` gets a selectorText).
  if (selector.trimStart().startsWith('@')) return true;
  let text: unknown;
  try {
    sheet.insertRule(`${selector}{}`, 0);
  } catch {
    return true;
  }
  try {
    text = sheet.cssRules.item(0)?.selectorText;
  } catch {
    text = undefined;
  }
  try {
    sheet.deleteRule(0);
  } catch {
    /* a fresh sheet is made below if this one is left non-empty */
  }
  if (typeof text !== 'string' || text.length === 0) return true;
  if (asciiLower(text).includes('::highlight(')) return true;
  let hit: boolean;
  try {
    hit = opts.hitsRoot(text);
  } catch {
    return true;
  }
  return hit && (style === undefined || !rootSafeStyle(style));
}

export async function validateSelectors(pairs: ReadonlyArray<readonly [id: number, selector: string]>, opts: SelectorCheckOptions): Promise<number[]> {
  const drop: number[] = [];
  let sheet = new opts.CSSStyleSheet();
  let sliceStart = opts.now();
  for (const [id, selector] of pairs) {
    if (opts.now() - sliceStart >= opts.sliceMs) {
      await opts.yield();
      sliceStart = opts.now();
    }
    if (typeof selector !== 'string' || rejects(sheet, selector, opts, opts.styles?.get(id))) drop.push(id);
    // A rule the sheet could not delete would shift what item(0) reads next: start over with an empty sheet.
    if (sheet.cssRules.item(0) !== null) sheet = new opts.CSSStyleSheet();
  }
  return drop;
}
