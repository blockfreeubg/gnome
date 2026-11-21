/**
 * The filter-list sanitizer (WAVE-B3 §5.1, §5.2, D1, D11, §11.3, §11.5). Lane x1's build Worker runs it on every list
 * before `FiltersEngine.parse`, so what it removes never reaches an engine. Pure and DOM-free: it compiles in every
 * scope (app, engine host, Worker, service worker) and imports nothing, in particular not `@ghostery/adblocker` (the
 * app graph may import `src/extensions/core/**`, the library may not enter it).
 *
 * Line by line (lines are trimmed and `\`-continued lines joined exactly as the library's list parser does, so every
 * line is classified as the library will see it):
 *  1. Comments and `[Adblock …]` headers are dropped. `!#if` / `!#else` / `!#endif` stay in `text` and are tracked as
 *     the library tracks them; every `!#if` still open at the end of the list is closed, so a list cannot reach into
 *     the next list of the same group text. An `!#else` or `!#endif` without an open `!#if` is dropped (it would
 *     otherwise act on the conditions of whatever text precedes this list). `!#include` is dropped and counted.
 *  2. Trust (lists without `trusted`): a scriptlet line (`…##+js(…)`) whose name, taken as the library takes it, is a
 *     scriptlet that needs trust (`opts.requiresTrust`, every name and alias) or starts with `trusted-`. When
 *     `requiresTrust` is empty (the resources file was malformed) every scriptlet line of the list is dropped: fail
 *     closed for code, never for blocking. A name that is not a plain token (`[A-Za-z0-9._-]`) resolves to no
 *     scriptlet in the library and is dropped too, so a quoting trick cannot make the two parsers disagree.
 *  3. Arguments (lists without `trusted`): a scriptlet line whose text after the name contains a backtick or `$`.
 *  4. ABP CSS `domain##selector {style}` becomes `domain##selector:style(style)`; `{remove: true}` becomes plain hiding.
 *  5. `:style(…)` only with declarations `isSafeStyle` accepts. And every hiding or `:style()` rule only with a
 *     selector `isSafeSelectorText` accepts (added by the lane review, 2026-11-19): the library pastes selectors into
 *     its stylesheet text unchanged, and a DOM-less build keeps `example.com##div{background:url(//x);a:b`, whose brace
 *     opens a block of the list's own declarations (measured: the library's stylesheet text then reads
 *     `div{background:url(//x);a:b,\n.ad { display: none !important; }`, and in Chromium and Firefox that sheet gives
 *     every div the background and hides nothing), so neither "hiding rules are display: none" nor the `:style()`
 *     check would hold.
 *  6. Unsupported or unsafe syntax is dropped and counted: `#?#`, `#@?#`, `#$?#` (procedural, CSS injection), `##^…`
 *     and `#@#^…` (HTML filtering), `#$#`, `#@$#` (ABP snippets), `#%#`, `#@%#` (AdGuard JavaScript: raw code),
 *     network filters with `$replace`/`$content` (HTML filtering) or `$csp` (not emulated, D12), lines over 8 KiB.
 *  7. Shared lines (D1): network exceptions `@@…`, cosmetic exceptions `#@#…`, `$badfilter` filters and non-exception
 *     `$redirect-rule` filters go to `shared`, each wrapped in the `!#if` conditions open at its line.
 *  8. Params lines (D1, D13): non-exception `$removeparam` filters go to `params`, wrapped the same way.
 */

/**
 * Part of the content blocker's cache key (WAVE-B3 §4.3): bump it with every rule change of this file, and also of
 * selectors.ts' validation, which has no version of its own in the key (what either removes is baked into a cached
 * engine set). Still 1 after the lane review's rule changes of 2026-11-19/20: nothing has shipped (the blocker is
 * offered only in e2e builds, D19, whose browser profiles are thrown away), so no set cached under older rules exists.
 */
export const SANITIZER_VERSION = 1;

export interface SanitizeOptions {
  /** The list may use scriptlets that need trust (FilterListRef.trusted). */
  trusted: boolean;
  /** trustOnlyScriptlets() of the verified ubo-resources ref. */
  requiresTrust: ReadonlySet<string>;
}

export interface SanitizeResult {
  /** The list without its shared and params lines, every !#if closed, ready for FiltersEngine.parse. */
  text: string;
  /** Lines every group engine gets (exceptions, cosmetic exceptions, $badfilter, $redirect-rule), wrapped in their !#if conditions. */
  shared: string[];
  /** Non-exception $removeparam filters, wrapped the same way: the params group gets them (D1). */
  params: string[];
  /** Filter lines kept (text + shared + params) and dropped by the rules above. */
  rules: number;
  dropped: number;
}

/** Longest filter line kept (rule 6). */
const MAX_LINE = 8 * 1024;
/** Longest `:style()` declaration block kept (rule 5). */
const MAX_STYLE = 1024;

/** ABP CSS injection `domain##selector {style}` (research §2.8): domains, separator, selector, declarations. */
const ABP_CSS_RE = /^([^#]*)(#@?#)(?![+^])(.+?)\s*\{([^{}]*)\}$/;
const ABP_REMOVE_RE = /^remove\s*:\s*true\s*;?$/i;
/** A scriptlet name the library can resolve: a plain token. */
const SCRIPTLET_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * What `:style()` may contain, compared ASCII-lowercased (CSS is ASCII case-insensitive): nothing that loads a
 * resource (`url(`, `src(`, the image functions, `element(`, `paint(`), runs code (`expression(`, `-moz-binding`,
 * `behavior`, `javascript:`), opens an at-rule or a block (`@`, `{`, `}`), hides anything from this check (escapes,
 * comments) or ends the style element (`<`); no control characters; at most 1,024 characters.
 */
const UNSAFE_STYLE = ['url(', 'src(', 'image(', 'image-set(', 'cross-fade(', 'element(', 'paint(', 'expression(', '-moz-binding', 'behavior', 'javascript:', '@', '\\', '/*', '<', '{', '}'];

/** ASCII lowercase only: CSS folds A–Z and nothing else. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function isSafeStyle(declarations: string): boolean {
  if (declarations.length > MAX_STYLE) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(declarations)) return false;
  const d = asciiLower(declarations);
  for (const bad of UNSAFE_STYLE) if (d.includes(bad)) return false;
  return balanced(declarations);
}

/**
 * Quotes closed and `(`/`[` balanced outside strings (escapes never get here: `\` is refused). An open string or
 * bracket would swallow the closing `}` of its rule, and with it every later rule of the document's stylesheet.
 */
function balanced(d: string): boolean {
  const open: number[] = [];
  let quote = 0;
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 /* " */ || c === 39 /* ' */) {
      quote = c;
    } else if (c === 40 /* ( */ || c === 91 /* [ */) {
      open.push(c);
    } else if (c === 41 /* ) */ || c === 93 /* ] */) {
      if (open.pop() !== (c === 41 ? 40 : 91)) return false;
    }
  }
  return quote === 0 && open.length === 0;
}

/**
 * Braces, a comment opener and control characters other than the tab: what could change the structure of the
 * stylesheet text a selector is pasted into.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_SELECTOR_RE = /[{}\u0000-\u0008\u000a-\u001f\u007f]|\/\*/;

/**
 * Whether a cosmetic rule's text after its separator (the selector, and its `:style()` part if any) may reach a
 * stylesheet (rule 5; added by the lane review, 2026-11-19): no `{` or `}` anywhere (inside quoted attribute values
 * too, so that no tokenizer subtlety can tell the two apart; 2 of the 55,530 hiding selectors of the default lists
 * have one there), no `/*` and no control character other than the tab. Without braces a selector produces no
 * block of its own, so the library's ` { display: none !important; }` (or the checked `:style()` declarations) stays
 * the only block its rule has. selectors.ts applies the same test on the engine host's main thread.
 */
export function isSafeSelectorText(text: string): boolean {
  return !UNSAFE_SELECTOR_RE.test(text);
}

/**
 * From the verified `ubo-resources` JSON (`{scriptlets: [{name, aliases, requiresTrust, …}], redirects}`): the name and
 * every alias of each scriptlet with `requiresTrust: true`, each with and without `.js`. Anything malformed gives the
 * empty set (the sanitizer then drops every scriptlet line of an untrusted list).
 */
export function trustOnlyScriptlets(resources: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  const empty: ReadonlySet<string> = new Set<string>();
  if (typeof resources !== 'object' || resources === null || Array.isArray(resources)) return empty;
  const scriptlets = (resources as { scriptlets?: unknown }).scriptlets;
  if (!Array.isArray(scriptlets)) return empty;
  const add = (name: string): void => {
    const base = name.endsWith('.js') ? name.slice(0, -3) : name;
    if (base.length === 0) return;
    out.add(base);
    out.add(`${base}.js`);
  };
  for (const s of scriptlets as unknown[]) {
    if (typeof s !== 'object' || s === null) return empty;
    const { name, aliases, requiresTrust } = s as { name?: unknown; aliases?: unknown; requiresTrust?: unknown };
    if (typeof name !== 'string' || (aliases !== undefined && !Array.isArray(aliases))) return empty;
    if (requiresTrust !== true) continue;
    add(name);
    for (const a of (aliases ?? []) as unknown[]) {
      if (typeof a !== 'string') return empty;
      add(a);
    }
  }
  return out;
}

/** The library's `joinConditions`: one condition as it is, several as `(a)&&(b)`. */
function joinConditions(conditions: readonly string[]): string {
  return conditions.length === 1 ? (conditions[0] ?? '') : conditions.map((c) => `(${c})`).join('&&');
}

/** The last `$` not preceded by a backslash (the library's options separator), or -1. */
function optionsIndex(line: string): number {
  let i = line.lastIndexOf('$');
  while (i > 0 && line.charCodeAt(i - 1) === 92 /* \ */) i = line.lastIndexOf('$', i - 1);
  return i;
}

/** The option names of a network filter (`~` removed, lower case), split at commas that are not escaped. */
function networkOptions(line: string): Set<string> {
  const names = new Set<string>();
  const i = optionsIndex(line);
  if (i === -1 || line.charCodeAt(i + 1) === 47 /* / */) return names;
  const opts = line.slice(i + 1);
  let start = 0;
  for (let j = 0; j <= opts.length; j++) {
    if (j === opts.length || (opts.charCodeAt(j) === 44 /* , */ && opts.charCodeAt(j - 1) !== 92)) {
      const part = opts.slice(start, j);
      const eq = part.indexOf('=');
      let name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
      if (name.startsWith('~')) name = name.slice(1);
      if (name) names.add(name);
      start = j + 1;
    }
  }
  return names;
}

type Kind =
  | { type: 'network' }
  | { type: 'cosmetic'; sharp: number; exception: boolean; body: number }
  | { type: 'unsupported' };

/**
 * The library's `detectFilterType` (lists.js), restated: network heuristics first, AdGuard HTML rules (`$$`, `$@$`),
 * then the first `#` decides between cosmetic (`##`, `#@#`), unsupported (`#?#`, `#$#`, `#%#` and their exceptions)
 * and network. `body` is the index after the separator.
 */
function classify(line: string): Kind {
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(1);
  const last = line.charCodeAt(line.length - 1);
  if (
    (c0 === 36 /* $ */ && c1 !== 36 && c1 !== 64) ||
    c0 === 38 /* & */ ||
    c0 === 42 /* * */ ||
    c0 === 45 /* - */ ||
    c0 === 46 /* . */ ||
    c0 === 47 /* / */ ||
    c0 === 58 /* : */ ||
    c0 === 61 /* = */ ||
    c0 === 63 /* ? */ ||
    c0 === 64 /* @ */ ||
    c0 === 95 /* _ */ ||
    c0 === 124 /* | */ ||
    last === 124
  ) {
    return { type: 'network' };
  }
  const dollar = line.indexOf('$');
  if (dollar !== -1 && dollar !== line.length - 1) {
    const n = line.charCodeAt(dollar + 1);
    if (n === 36 || (n === 64 && line.startsWith('@$', dollar + 1))) return { type: 'unsupported' };
  }
  const sharp = line.indexOf('#');
  if (sharp !== -1 && sharp !== line.length - 1) {
    const rest = line.slice(sharp + 1);
    if (rest.startsWith('#')) return { type: 'cosmetic', sharp, exception: false, body: sharp + 2 };
    if (rest.startsWith('@#')) return { type: 'cosmetic', sharp, exception: true, body: sharp + 3 };
    if (/^(?:@\$#|@%#|@\?#|%#|\$#|\$\?#|\?#)/.test(rest)) return { type: 'unsupported' };
  }
  return { type: 'network' };
}

/** The scriptlet name as the library resolves it: after `+js(` up to the first `,` (or the final character), trimmed. */
function scriptletParts(line: string, bodyStart: number): { name: string; rest: string } {
  const inner = line.slice(bodyStart + 4, line.length - 1);
  const comma = inner.indexOf(',');
  return comma === -1 ? { name: inner.trim(), rest: '' } : { name: inner.slice(0, comma).trim(), rest: inner.slice(comma + 1) };
}

/** The lines as the library's parser sees them: trimmed, `␠\` continuations joined (lists.js `parseFilters`). */
function* logicalLines(text: string): Generator<string> {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    if (line.length !== 0 && line.charCodeAt(0) <= 32) line = line.trimStart();
    if (line.length > 2) {
      while (i < lines.length - 1 && line.charCodeAt(line.length - 1) === 92 && line.charCodeAt(line.length - 2) === 32) {
        line = line.slice(0, -2);
        const next = lines[i + 1] ?? '';
        if (next.length > 4 && next.startsWith('    ') && next.charCodeAt(4) !== 32) {
          line += next.slice(4);
          i++;
        } else {
          break;
        }
      }
    }
    if (line.length !== 0 && line.charCodeAt(line.length - 1) <= 32) line = line.trimEnd();
    yield line;
  }
}

export function sanitizeList(text: string, opts: SanitizeOptions): SanitizeResult {
  const out: string[] = [];
  const shared: string[] = [];
  const params: string[] = [];
  const conditions: string[] = [];
  let rules = 0;
  let dropped = 0;
  const wrap = (line: string): string => (conditions.length === 0 ? line : `!#if ${joinConditions(conditions)}\n${line}\n!#endif`);

  for (let line of logicalLines(text)) {
    if (line.length === 0) continue;
    const c0 = line.charCodeAt(0);
    // Comments, headers and preprocessor directives (the library: '!', '#' + whitespace, '[Adblock').
    if (c0 === 33 /* ! */) {
      if (line.startsWith('!#if ')) {
        conditions.push(line.slice(5).replace(/\s/g, ''));
        out.push(line);
      } else if (line === '!#else') {
        if (conditions.length > 0) {
          conditions.push(`!(${conditions.pop() ?? ''})`);
          out.push(line);
        }
      } else if (line === '!#endif') {
        if (conditions.length > 0) {
          conditions.pop();
          out.push(line);
        }
      } else if (line.startsWith('!#include')) {
        dropped++;
      }
      continue;
    }
    if ((c0 === 35 /* # */ && line.charCodeAt(1) <= 32) || line.startsWith('[Adblock')) continue;
    if (line.length > MAX_LINE) {
      dropped++;
      continue;
    }

    let kind = classify(line);
    if (kind.type === 'unsupported') {
      dropped++;
      continue;
    }

    if (kind.type === 'network') {
      const exception = line.startsWith('@@');
      const names = networkOptions(line);
      if (names.has('csp') || names.has('replace') || names.has('content') || /[$,]~?(?:replace|content)(?:[=,]|$)/i.test(line)) {
        dropped++;
        continue;
      }
      rules++;
      if (exception || names.has('badfilter') || names.has('redirect-rule')) shared.push(wrap(line));
      else if (names.has('removeparam')) params.push(wrap(line));
      else out.push(line);
      continue;
    }

    // Cosmetic. ABP CSS injection first (rule 4), so the result is checked like any :style() rule.
    const abp = ABP_CSS_RE.exec(line);
    if (abp && !(abp[3] ?? '').includes(':style(')) {
      const [, domains = '', sep = '', selector = '', style = ''] = abp;
      const decl = style.trim();
      line = ABP_REMOVE_RE.test(decl) ? `${domains}${sep}${selector}` : `${domains}${sep}${selector}:style(${decl})`;
      kind = classify(line);
      if (kind.type !== 'cosmetic') {
        dropped++;
        continue;
      }
    }
    const { exception, body } = kind;
    if (line.charCodeAt(body) === 94 /* ^ */) {
      dropped++; // HTML filtering (off in v1)
      continue;
    }
    const isScriptlet = line.startsWith('+js(', body);
    if (isScriptlet && !exception && !opts.trusted) {
      const { name, rest } = scriptletParts(line, body);
      const full = name.endsWith('.js') ? name : `${name}.js`;
      if (
        opts.requiresTrust.size === 0 ||
        !SCRIPTLET_NAME_RE.test(name) ||
        name.startsWith('trusted-') ||
        opts.requiresTrust.has(name) ||
        opts.requiresTrust.has(full) ||
        rest.includes('`') ||
        rest.includes('$')
      ) {
        dropped++;
        continue;
      }
    }
    if (!isScriptlet && !exception) {
      if (!isSafeSelectorText(line.slice(body))) {
        dropped++;
        continue;
      }
      const at = line.endsWith(')') ? line.indexOf(':style(', body) : -1;
      if (at !== -1 && !isSafeStyle(line.slice(at + 7, -1))) {
        dropped++;
        continue;
      }
    }
    rules++;
    if (exception) shared.push(wrap(line));
    else out.push(line);
  }

  for (let i = conditions.length; i > 0; i--) out.push('!#endif');
  return { text: out.join('\n'), shared, params, rules, dropped };
}
