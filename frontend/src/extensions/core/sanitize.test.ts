// The list sanitizer (WAVE-B3 §5.1, §5.4): every rule, the !#if wrapping of shared and params lines, trust by name and
// alias of the pinned resources, the argument rule, counts, idempotence, speed, and what the real library makes of the
// output (the wrapped conditions evaluate, converted ABP rules become :style() filters, dropped lines never reach it).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { describe, expect, it } from 'vitest';
import { SANITIZER_VERSION, isSafeSelectorText, isSafeStyle, sanitizeList, trustOnlyScriptlets } from './sanitize';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
/** Scriptlet metadata of the server's ubo-resources mirror (see the file's "//" note). */
const RESOURCES = JSON.parse(readFileSync(here('../cosmetic/testdata/ubo-scriptlets.json'), 'utf8')) as {
  scriptlets: Array<{ name: string; aliases: string[]; requiresTrust?: boolean }>;
};
const TRUST = trustOnlyScriptlets(RESOURCES);
const UNTRUSTED = { trusted: false, requiresTrust: TRUST } as const;
const TRUSTED = { trusted: true, requiresTrust: TRUST } as const;
const lines = (s: string): string[] => s.split('\n').filter((l) => l.length > 0);

describe('trustOnlyScriptlets', () => {
  it('collects every name and alias of the scriptlets that need trust, with and without .js', () => {
    const need = RESOURCES.scriptlets.filter((s) => s.requiresTrust === true);
    expect(need.length).toBe(34);
    for (const s of need) {
      for (const n of [s.name, ...s.aliases]) {
        const base = n.replace(/\.js$/, '');
        expect(TRUST.has(base)).toBe(true);
        expect(TRUST.has(`${base}.js`)).toBe(true);
      }
    }
    for (const n of ['prevent-clipboard-write', 'trusted-replace-node-text', 'trusted-rpnt', 'replace-node-text', 'rpnt', 'trusted-set.js']) expect(TRUST.has(n)).toBe(true);
    expect(TRUST.has('set-constant')).toBe(false);
    expect(TRUST.has('set-cookie.js')).toBe(false);
    expect(TRUST.size).toBe(need.reduce((n, s) => n + 2 * (1 + s.aliases.length), 0));
  });

  it('gives the empty set for anything malformed', () => {
    for (const bad of [null, 1, 'x', [], {}, { scriptlets: {} }, { scriptlets: [null] }, { scriptlets: [{ aliases: [] }] }, { scriptlets: [{ name: 'a', aliases: 'b', requiresTrust: true }] }, { scriptlets: [{ name: 'a', aliases: [1], requiresTrust: true }] }]) {
      expect(trustOnlyScriptlets(bad).size).toBe(0);
    }
  });

  it('matches the e2e pinned resources file once lane x5 has added it', () => {
    const pinned = here('../../../../tests/e2e/engine/fixtures/blocker/lists/ubo-resources.json');
    if (!existsSync(pinned)) return; // [x5] added on its day one; the metadata copy above is what this test pins meanwhile
    const full = JSON.parse(readFileSync(pinned, 'utf8')) as unknown;
    expect([...trustOnlyScriptlets(full)].sort()).toEqual([...TRUST].sort());
  });
});

describe('sanitizeList: comments and preprocessor lines', () => {
  it('drops comments and headers, keeps !#if/!#else/!#endif, counts !#include', () => {
    const r = sanitizeList('[Adblock Plus 2.0]\n! Title: x\n# comment\n!#include other.txt\n!#if env_firefox\n##.a\n!#else\n##.b\n!#endif\n', UNTRUSTED);
    expect(r.text).toBe('!#if env_firefox\n##.a\n!#else\n##.b\n!#endif');
    expect(r.rules).toBe(2);
    expect(r.dropped).toBe(1);
  });

  it('closes every !#if still open at the end, and drops !#else / !#endif without an open !#if', () => {
    const r = sanitizeList('!#endif\n!#else\n!#if a\n!#if b\n##.x', UNTRUSTED);
    expect(r.text).toBe('!#if a\n!#if b\n##.x\n!#endif\n!#endif');
  });

  it('joins continued lines and trims, as the library does', () => {
    const r = sanitizeList('  example.com##.a, \\\n    .b  \r\n', UNTRUSTED);
    expect(r.text).toBe('example.com##.a,.b');
  });
});

describe('sanitizeList: shared and params lines (D1)', () => {
  it('moves exceptions, cosmetic exceptions, $badfilter and $redirect-rule to shared, $removeparam to params', () => {
    const r = sanitizeList(
      ['||ads.example^', '@@||ok.example^', 'site.example#@#.ad', 'site.example#@#+js(set-constant, a, 1)', '||x.example^$badfilter', '||t.example^$redirect-rule=noop.js', '@@||t.example^$redirect-rule', '||t.example^$redirect=noop.js', '$removeparam=gnome_e2e', '@@||a.example^$removeparam', '@@||site.example^$generichide'].join('\n'),
      UNTRUSTED,
    );
    expect(lines(r.text)).toEqual(['||ads.example^', '||t.example^$redirect=noop.js']);
    expect(r.shared).toEqual(['@@||ok.example^', 'site.example#@#.ad', 'site.example#@#+js(set-constant, a, 1)', '||x.example^$badfilter', '||t.example^$redirect-rule=noop.js', '@@||t.example^$redirect-rule', '@@||a.example^$removeparam', '@@||site.example^$generichide']);
    expect(r.params).toEqual(['$removeparam=gnome_e2e']);
    expect(r.rules).toBe(11);
    expect(r.dropped).toBe(0);
  });

  it('wraps them in the conditions open at their line, also under !#else and nested', () => {
    const r = sanitizeList(['!#if env_firefox', '@@||a.example^', '!#if !ext_ublock', '$removeparam=p', '!#else', '@@||b.example^', '!#endif', '!#else', 'x.example#@#.c', '!#endif', '@@||d.example^', '!#if  cap_html_filtering ', '@@||e.example^'].join('\n'), UNTRUSTED);
    expect(r.shared).toEqual([
      '!#if env_firefox\n@@||a.example^\n!#endif',
      '!#if (env_firefox)&&(!(!ext_ublock))\n@@||b.example^\n!#endif',
      '!#if !(env_firefox)\nx.example#@#.c\n!#endif',
      '@@||d.example^',
      '!#if cap_html_filtering\n@@||e.example^\n!#endif',
    ]);
    expect(r.params).toEqual(['!#if (env_firefox)&&(!ext_ublock)\n$removeparam=p\n!#endif']);
    expect(r.text).toBe('!#if env_firefox\n!#if !ext_ublock\n!#else\n!#endif\n!#else\n!#endif\n!#if  cap_html_filtering\n!#endif');
  });

  it('the library evaluates the wrapped conditions as it evaluated the originals', () => {
    const list = ['||a.example^', '!#if env_firefox', '@@||a.example^', '!#else', '||b.example^', '!#endif'].join('\n');
    const r = sanitizeList(list, UNTRUSTED);
    const text = [r.text, ...r.shared].join('\n');
    for (const firefox of [true, false]) {
      const e = FiltersEngine.parse(text, { loadPreprocessors: true });
      e.updateEnv(new Map([['env_firefox', firefox]]) as never);
      const req = (u: string) => Request.fromRawDetails({ url: u, sourceUrl: 'https://site.example/', type: 'script' });
      expect(e.match(req('https://a.example/x.js')).match).toBe(!firefox);
      expect(e.match(req('https://b.example/x.js')).match).toBe(!firefox);
    }
  });
});

describe('sanitizeList: trust (rule 2)', () => {
  const need = RESOURCES.scriptlets.filter((s) => s.requiresTrust === true).flatMap((s) => [s.name, ...s.aliases]);

  it('drops every name and alias that needs trust, with and without .js and spaces, from an untrusted list only', () => {
    for (const n of need) {
      const base = n.replace(/\.js$/, '');
      for (const spelled of [base, `${base}.js`, ` ${base} `, `\t${base}.js`]) {
        for (const tail of ['', ', a, b']) {
          const line = `x.example##+js(${spelled}${tail})`;
          const u = sanitizeList(line, UNTRUSTED);
          expect(u.text, line).toBe('');
          expect(u.dropped).toBe(1);
          const t = sanitizeList(line, TRUSTED);
          expect(t.text).toBe(line);
          expect(t.rules).toBe(1);
        }
      }
    }
  });

  it('drops every trusted- name (prefix, no flag), keeps exceptions and scriptlets that need no trust', () => {
    expect(sanitizeList('x.example##+js(trusted-prevent-xhr, a)', UNTRUSTED).text).toBe('');
    expect(sanitizeList('x.example##+js(trusted-anything-new)', UNTRUSTED).text).toBe('');
    const r = sanitizeList('x.example#@#+js(rpnt)\nx.example##+js(set-constant, a, 1)\nx.example##+js(nowoif)', UNTRUSTED);
    expect(r.shared).toEqual(['x.example#@#+js(rpnt)']);
    expect(lines(r.text)).toEqual(['x.example##+js(set-constant, a, 1)', 'x.example##+js(nowoif)']);
  });

  it('drops names that are not plain tokens (a quoting trick resolves to nothing in the library)', () => {
    for (const l of ['x.example##+js("rpnt", a)', 'x.example##+js(`rpnt`)', 'x.example##+js(/a,b/, c)', 'x.example##+js(rp nt)']) expect(sanitizeList(l, UNTRUSTED).text, l).toBe('');
  });

  it('with an empty requiresTrust (malformed resources) drops every scriptlet line of an untrusted list, not of a trusted one', () => {
    const l = 'x.example##+js(set-constant, a, 1)\nx.example##.ad';
    expect(sanitizeList(l, { trusted: false, requiresTrust: new Set() }).text).toBe('x.example##.ad');
    expect(sanitizeList(l, { trusted: true, requiresTrust: new Set() }).text).toBe(l);
  });

  it('the library resolves what the sanitizer let through to scriptlets that need no trust', () => {
    // The names the review used (§11.4) and a case variant, against the same lookup the library makes.
    const byName = new Map<string, boolean>();
    for (const s of RESOURCES.scriptlets) for (const n of [s.name, ...s.aliases]) byName.set(n, s.requiresTrust === true);
    for (const l of ['c.test##+js(rpnt, script, foo, bar)', 'd.test##+js(replace-node-text, script, foo, bar)', 'e.test##+js(prevent-clipboard-write)', 'x.test##+js( trusted-set-cookie, a, b)']) {
      expect(sanitizeList(l, UNTRUSTED).text).toBe('');
    }
    // RPNT resolves to nothing in the library either (its lookup is case-sensitive)
    expect(byName.has('RPNT.js')).toBe(false);
    expect(sanitizeList('x.test##+js(RPNT, a)', UNTRUSTED).text).toBe('x.test##+js(RPNT, a)');
  });
});

describe('sanitizeList: arguments (rule 3)', () => {
  it('drops untrusted scriptlet lines with a backtick or $ in their arguments, keeps them in trusted lists', () => {
    const bad = [
      'visible.com##+js(set-local-storage-item, browser-ids, $remove$)',
      'a.test##+js(set-constant, foo, x`-Function`globalThis.PWNED=1```-`)',
      "x.test##+js(set-constant, $', \\,PWNED=6\\,0, \\,0)",
      'x.test##+js(set-constant, a, $&)',
    ];
    for (const l of bad) {
      expect(sanitizeList(l, UNTRUSTED).text, l).toBe('');
      expect(sanitizeList(l, TRUSTED).text, l).toBe(l);
    }
    expect(sanitizeList('x.test##+js(set-constant, /^a$/, 1)', UNTRUSTED).text).toBe(''); // `$` anywhere in the arguments
    expect(sanitizeList('x.test##+js(set-constant, a, 1)', UNTRUSTED).text).toBe('x.test##+js(set-constant, a, 1)');
  });
});

describe('sanitizeList: ABP CSS and :style() (rules 4, 5)', () => {
  it('converts {style} to :style() and {remove: true} to plain hiding', () => {
    expect(sanitizeList('w3schools.com##.ad {top: 0 !important}', UNTRUSTED).text).toBe('w3schools.com##.ad:style(top: 0 !important)');
    expect(sanitizeList('x.example##.a, .b { remove: true; }', UNTRUSTED).text).toBe('x.example##.a, .b');
    expect(sanitizeList('x.example#@#.a {color: red}', UNTRUSTED).shared).toEqual(['x.example#@#.a:style(color: red)']);
  });

  it('drops unsafe :style() rules, also converted ones and in trusted lists', () => {
    for (const l of ['x.example##.a:style(background: url(//cdn.localhost/beacon))', 'x.example##.a:style(background: URL(//cdn.localhost/beacon))', 'x.example##.a {background: Image-Set("x.png" 1x)}', 'x.example##.a:style(background: \\75 rl(x))']) {
      expect(sanitizeList(l, UNTRUSTED).text, l).toBe('');
      expect(sanitizeList(l, TRUSTED).dropped, l).toBe(1);
    }
    expect(sanitizeList('x.example##.a:style(color: red !important)', UNTRUSTED).text).toBe('x.example##.a:style(color: red !important)');
  });

  it('the library parses a converted rule as a :style() filter (one rule for one selector)', () => {
    const r = sanitizeList('site.example##.good {top: 0}', UNTRUSTED);
    const e = FiltersEngine.parse(r.text, { loadCosmeticFilters: true });
    const c = e.getCosmeticsFilters({ url: 'https://site.example/', hostname: 'site.example', domain: 'site.example', getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromDOM: false });
    expect(c.styles).toContain('.good');
    expect(c.styles).toContain('top: 0');
    expect(c.styles).not.toContain('display: none');
  });

  it('isSafeStyle', () => {
    const unsafe = ['background: url(x)', 'background:URL(x)', 'background: image(x)', 'background: Image-Set(x 1x)', 'background: -webkit-image-set(x 1x)', 'background: cross-fade(a, b)', 'background: element(#a)', 'background: paint(x)', 'width: expression(alert(1))', '-moz-binding: x', 'behavior: x', 'x: \\75 rl(a)', 'a: b /* c */', '@import x', 'a: b} c {d: e', 'content: "</style>"', 'background: JavaScript:x', 'mask: src("x")', 'a: b\u0000', 'x'.repeat(1025)];
    for (const s of unsafe) expect(isSafeStyle(s), s).toBe(false);
    for (const s of ['display: none !important', 'top: 0; left: 0', 'visibility: hidden', 'height: 1px !important; min-height: 0', 'x'.repeat(1024)]) expect(isSafeStyle(s), s).toBe(true);
  });

  it('isSafeStyle refuses an open string or bracket (it would swallow the rest of the stylesheet), keeps balanced ones', () => {
    for (const s of ['content: "x', "content: 'x", 'width: calc(100% - 1px', 'width: calc(1px))', 'x: [a', 'x: a]', 'x: ([)]']) expect(isSafeStyle(s), s).toBe(false);
    // the shapes of the default lists (ublock-badware's content strings, calc, var)
    for (const s of ["content: 'uBlock is unrelated to the well-known uBlock Origin.' !important; font-size: 32px !important", 'width: calc(100% - (2 * 4px)) !important', 'font-size: var(--font-size-h2) !important', 'content: "a ( [ b"']) {
      expect(isSafeStyle(s), s).toBe(true);
    }
  });
});

describe('sanitizeList: selectors that could carry their own declarations (rule 5, lane review)', () => {
  // A brace in a selector opens a block in the library's stylesheet text (it pastes selectors unchanged and, without
  // a DOM, validates nothing), so a list could set any declaration, url() included, through a plain hiding rule.
  const vectors = [
    'example.com##div{background:url(//cdn.localhost/beacon);a:b',
    'example.com##span{color:red !important;a:b:style(opacity: 0.5)',
    'example.com##.a{}html{display:none',
    'example.com##.x {display:none} body {background: url(//cdn.localhost/b)}',
    '##.generic{background-image:url(//cdn.localhost/g);a:b',
    'example.com##a[title="}"]',
    'example.com##div/*',
    'example.com##div\u000c.ad',
    'example.com##div\r.ad',
  ];

  it('the library keeps such a line and writes its brace into the stylesheet (why the rule exists)', () => {
    const e = FiltersEngine.parse(vectors[0] ?? '', { loadCosmeticFilters: true });
    const c = e.getCosmeticsFilters({ url: 'https://example.com/', hostname: 'example.com', domain: 'example.com', getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromDOM: false });
    expect(c.styles).toContain('div{background:url(//cdn.localhost/beacon);a:b');
  });

  it('drops them from untrusted and trusted lists alike, and counts them', () => {
    for (const opts of [UNTRUSTED, TRUSTED]) {
      const r = sanitizeList(vectors.join('\n'), opts);
      expect(r.text, JSON.stringify(opts.trusted)).toBe('');
      expect(r.dropped).toBe(vectors.length);
      expect(r.rules).toBe(0);
    }
    expect(isSafeSelectorText('div[id^="ad-"] > .x:not(.y)')).toBe(true);
    expect(isSafeSelectorText('div\t.ad')).toBe(true);
  });

  it('what the sanitizer keeps gives the library no stylesheet with a brace of the list', () => {
    const r = sanitizeList([...vectors, 'example.com##.kept', 'example.com##.styled:style(color: red)'].join('\n'), UNTRUSTED);
    const e = FiltersEngine.parse(r.text, { loadCosmeticFilters: true });
    const c = e.getCosmeticsFilters({ url: 'https://example.com/', hostname: 'example.com', domain: 'example.com', getBaseRules: true, getInjectionRules: false, getExtendedRules: false, getRulesFromDOM: false });
    expect(c.styles).toContain('.kept');
    expect(c.styles).toContain('.styled { color: red }');
    expect(c.styles).not.toContain('beacon');
    expect(c.styles.match(/\{/g)?.length).toBe(c.styles.match(/\}/g)?.length);
    expect(c.styles.match(/\{/g)?.length).toBe(2);
  });

  it('leaves exceptions and scriptlet arguments with braces alone (they never reach a stylesheet)', () => {
    const r = sanitizeList('x.example#@#div{a\nx.example##+js(set-constant, a, {})', UNTRUSTED);
    expect(r.shared).toEqual(['x.example#@#div{a']);
    expect(r.text).toBe('x.example##+js(set-constant, a, {})');
    expect(sanitizeList('x.example##+js(trusted-set-constant, a, {"b":1})', TRUSTED).text).toBe('x.example##+js(trusted-set-constant, a, {"b":1})');
  });
});

describe('sanitizeList: unsupported syntax (rule 6)', () => {
  it('drops and counts procedural, HTML filtering, snippets, AdGuard JS, $replace/$content/$csp and long lines', () => {
    const bad = [
      'x.example#?#.a:has-text(b)',
      'x.example#@?#.a:has-text(b)',
      'x.example#$?#.a { color: red }',
      'x.example##^script:has-text(ad)',
      'x.example#@#^script:has-text(ad)',
      'x.example#$#abort-on-property-read x',
      'x.example#@$#abort-on-property-read x',
      'x.example#%#window.x=1',
      'x.example#@%#window.x=1',
      'x.example$$script[tag-content="ad"]',
      '||x.example^$replace=/a/b/',
      '||x.example^$content',
      '||x.example^$csp=script-src none',
      '@@||x.example^$csp',
      `||${'a'.repeat(8200)}.example^`,
    ];
    const r = sanitizeList(bad.join('\n'), UNTRUSTED);
    expect(r.text).toBe('');
    expect(r.shared).toEqual([]);
    expect(r.dropped).toBe(bad.length);
    expect(r.rules).toBe(0);
    // the same lines from a trusted list: trust never re-enables them
    expect(sanitizeList(bad.join('\n'), TRUSTED).dropped).toBe(bad.length);
  });

  it('keeps ordinary network and cosmetic lines, and what the library would drop itself', () => {
    const keep = ['||ads.example^$third-party', '/banner/*/img^', 'example.com##.ad', '##.generic-ad', 'example.com,~sub.example.com##div[id^="ad-"]', '||x.example/$script,domain=a.example|b.example', '||x.example^$popup'];
    const r = sanitizeList(keep.join('\n'), UNTRUSTED);
    expect(lines(r.text)).toEqual(keep);
    expect(r.rules).toBe(keep.length);
  });
});

describe('sanitizeList: idempotence, version, speed', () => {
  const sample = [
    '! comment',
    '!#if env_firefox',
    '||ads.example^$third-party',
    '@@||ok.example^',
    'x.example##.a {top: 0}',
    'x.example##.b { remove: true }',
    '!#else',
    'x.example##+js(set-constant, a, 1)',
    '$removeparam=utm_x',
    'x.example##+js(trusted-set-cookie, a, b)',
    '!#if cap_html_filtering',
    'x.example##^script:has-text(x)',
  ].join('\n');

  it('sanitize(sanitize(x)) === sanitize(x)', () => {
    const a = sanitizeList(sample, UNTRUSTED);
    const b = sanitizeList(a.text, UNTRUSTED);
    expect(b.text).toBe(a.text);
    expect(b.dropped).toBe(0);
    expect(b.shared).toEqual([]);
    const s = sanitizeList(a.shared.join('\n'), UNTRUSTED);
    expect(s.shared).toEqual(a.shared);
    const p = sanitizeList(a.params.join('\n'), UNTRUSTED);
    expect(p.params).toEqual(a.params);
  });

  it('is version 1', () => {
    expect(SANITIZER_VERSION).toBe(1);
  });

  it('sanitizes an EasyList-sized list in < 150 ms', () => {
    // ~75,000 lines of EasyList's shapes (EasyList had 74k lines on 2026-11-11).
    const shapes = ['||ads{n}.example^$third-party', '/banner{n}/*/img^', 'example{n}.com##.ad-{n}', '##.generic-ad-{n}', '@@||ok{n}.example^$script', 'ex{n}.com,~sub.ex{n}.com##div[id^="ad-{n}"]', 'w{n}.com##.ad {top: 0}', '! comment {n}', 'site{n}.com##+js(set-constant, a{n}, 1)', '||t{n}.example^$redirect-rule=noop.js'];
    const list = Array.from({ length: 75_000 }, (_, i) => (shapes[i % shapes.length] ?? '').replaceAll('{n}', String(i))).join('\n');
    sanitizeList(list, UNTRUSTED); // warm-up (a fresh Worker is colder: measured separately, see the lane report)
    const t0 = performance.now();
    const r = sanitizeList(list, UNTRUSTED);
    const ms = performance.now() - t0;
    expect(r.rules).toBe(67_500);
    expect(ms).toBeLessThan(150);
  });
});
