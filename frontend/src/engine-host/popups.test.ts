import { describe, expect, it } from 'vitest';
import { classifyTarget, getSubmissionUrl, isPopupRequested, linkDisposition, opensNothing, routeAction, tokenizeFeatures } from './popups';

describe('popup decisions', () => {
  it('detects a popup request like the HTML spec', () => {
    expect(isPopupRequested('')).toBe(false);
    expect(isPopupRequested('popup')).toBe(true);
    expect(isPopupRequested('popup=0')).toBe(false);
    expect(isPopupRequested('width=400,height=300')).toBe(true);
    expect(isPopupRequested('location=yes,toolbar=yes,menubar=yes,resizable=yes,scrollbars=yes,status=yes')).toBe(false);
    expect(isPopupRequested('noopener')).toBe(true);
    expect([...tokenizeFeatures(' Width = 400 , popup ')]).toEqual([
      ['width', '400'],
      ['popup', ''],
    ]);
  });

  it('classifies targets', () => {
    const names = new Set(['inner']);
    expect(classifyTarget('', names, true)).toBe('self');
    expect(classifyTarget('_self', names, false)).toBe('self');
    expect(classifyTarget('_blank', names, true)).toBe('new');
    expect(classifyTarget('_top', names, false)).toBe('tab-top');
    expect(classifyTarget('_top', names, true)).toBe('self');
    expect(classifyTarget('_parent', names, true)).toBe('self');
    expect(classifyTarget('_parent', names, false)).toBe('parent');
    expect(classifyTarget('_unfencedTop', names, false)).toBe('tab-top');
    expect(classifyTarget(' _TOP ', names, true)).toBe('self');
    expect(classifyTarget('inner', names, true)).toBe('frame');
    expect(classifyTarget('Inner', names, true)).toBe('new');
    expect(classifyTarget('elsewhere', names, true)).toBe('new');
  });

  it('acts where the sandbox would refuse the default navigation', () => {
    // The tab's top document: `_top`/`_parent` mean the tab itself. Ultraviolet leaves the attribute as the page
    // wrote it (the browser would aim at the app or the engine host: refused), Scramjet empties it (already right).
    expect(routeAction('self', '_top', '_top', false)).toBe('retarget-self');
    expect(routeAction('self', '_parent', '_parent', false)).toBe('retarget-self');
    expect(routeAction('self', '', '_top', false)).toBe('native');
    expect(routeAction('self', '_self', '_self', false)).toBe('native');
    expect(routeAction('self', '', '', false)).toBe('native');
    // Nested documents: only the frame itself and its descendants may be navigated by the browser.
    expect(routeAction('tab-top', '', '_top', false)).toBe('navigate');
    expect(routeAction('parent', '_parent', '_parent', false)).toBe('navigate');
    expect(routeAction('frame', 'inner', 'inner', true)).toBe('native');
    expect(routeAction('frame', 'sibling', 'sibling', false)).toBe('navigate');
    expect(routeAction('frame', '', 'inner', true)).toBe('navigate');
  });

  it('maps clicks to dispositions', () => {
    const c = { button: 0, ctrl: false, meta: false, shift: false, alt: false, apple: false };
    expect(linkDisposition(c, 'self')).toBeNull();
    expect(linkDisposition(c, 'new')).toBe('foreground');
    expect(linkDisposition({ ...c, button: 1 }, 'self')).toBe('background');
    expect(linkDisposition({ ...c, ctrl: true }, 'self')).toBe('background');
    expect(linkDisposition({ ...c, meta: true, apple: true }, 'self')).toBe('background');
    expect(linkDisposition({ ...c, meta: true }, 'self')).toBeNull();
    expect(linkDisposition({ ...c, shift: true }, 'self')).toBe('foreground');
    expect(linkDisposition({ ...c, alt: true }, 'new')).toBeNull();
    expect(linkDisposition({ ...c, button: 2 }, 'new')).toBeNull();
  });

  it('builds GET submission URLs and ignores blank opens', () => {
    // Files arrive by name (the page realm's FormData serialized them, realm.ts formEntries).
    expect(getSubmissionUrl('https://a.example/s?old=1#f', [['q', 'a b'], ['f', 'x.txt']])).toBe('https://a.example/s?q=a+b&f=x.txt#f');
    expect(getSubmissionUrl('javascript:alert(1)', [])).toBeNull();
    expect(opensNothing('')).toBe(true);
    expect(opensNothing(' about:blank ')).toBe(true);
    expect(opensNothing('about:blank#x')).toBe(true);
    expect(opensNothing('/x')).toBe(false);
  });
});

// ── WAVE-B3 §3.3 withPageAssignments (x2's scriptlet runner) ──
import vm from 'node:vm';
import { installPopupRouting, withPageAssignments } from './popups';
import type { PopupSink } from './popups';
import type { Natives } from './natives';

describe('withPageAssignments', () => {
  const docs = new WeakMap<object, object>();
  const N = {
    winDocument(this: object) {
      let d = docs.get(this);
      if (!d) docs.set(this, (d = {}));
      return d;
    },
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    defineProperty: Object.defineProperty,
    getPrototypeOf: Object.getPrototypeOf,
    fnToString: Function.prototype.toString,
    apply: Reflect.apply,
    on: { call: () => undefined },
    setTimeout: (f: () => void) => setTimeout(f, 0),
  } as unknown as Natives;

  function setup() {
    const ctx = vm.createContext({});
    const run = <T,>(code: string): T => vm.runInContext(code, ctx) as T;
    run('globalThis.window = globalThis; globalThis.open = function open() { return "native"; }; globalThis.close = function close() {};');
    const win = run<Window>('globalThis');
    const opened: string[] = [];
    const sink = {
      realUrl: (raw: string) => (raw.startsWith('http') ? raw : null),
      documentUrl: () => 'https://site-a.example/',
      frameNames: () => new Set<string>(),
      frameWindow: () => null,
      tabTop: () => win,
      open: (url: string) => void opened.push(url),
      download: () => undefined,
      close: () => undefined,
      navigate: () => undefined,
      apple: () => false,
    } as unknown as PopupSink;
    installPopupRouting(win, N, sink, true);
    return { run, win, opened };
  }

  it('discards assignments outside a run (an engine wrapper stays behind GNOME’s function)', () => {
    const { run, opened } = setup();
    run('const gnome = window.open; window.open = function uv(u) { return "uv"; }; globalThis.same = window.open === gnome;');
    expect(run('same')).toBe(true);
    expect(run('window.open("https://pop.example/", "_blank")')).toBeNull();
    expect(opened).toEqual(['https://pop.example/']);
  });

  it('keeps an assignment made inside a run; the assigned wrapper reaches GNOME’s function when it lets a popup through', () => {
    const { run, win, opened } = setup();
    withPageAssignments(win, () => {
      run(`const orig = window.open; window.open = new Proxy(orig, { apply(t, th, a) { return String(a[0]).includes("ad") ? null : Reflect.apply(t, th, a); } });`);
    });
    expect(run('window.open("https://ad.example/")')).toBeNull();
    expect(opened).toEqual([]);
    run('window.open("https://ok.example/")');
    expect(opened).toEqual(['https://ok.example/']);
    // Later assignments (outside a run) are discarded again; the scriptlet's wrapper stays.
    run('window.open = function later() { return "later"; }');
    expect(run('window.open("https://ok2.example/")')).toBeNull();
    expect(opened).toEqual(['https://ok.example/', 'https://ok2.example/']);
    expect(run('typeof window.close')).toBe('function');
  });

  it('nests and ends even when the run throws', () => {
    const { run, win } = setup();
    expect(() =>
      withPageAssignments(win, () => {
        withPageAssignments(win, () => undefined);
        throw new Error('x');
      }),
    ).toThrow('x');
    run('window.open = function late() { return "late"; }');
    expect(run('window.open.name')).not.toBe('late');
  });
});
