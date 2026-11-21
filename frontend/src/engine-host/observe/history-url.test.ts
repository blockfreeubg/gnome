// The History URL fix (history-url.ts, worklist A12) in a node `vm` realm standing in for a proxied page: a pushState /
// replaceState without a URL (or with undefined/null) gets the document's real URL, everything else passes through,
// and what GNOME installs is a callable of the page's realm.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Natives } from '../natives';
import { pageKit } from '../realm';
import { wrapHistoryUrl } from './history-url';

const docs = new WeakMap<object, object>();
function winDocument(this: object): object {
  let d = docs.get(this);
  if (!d) docs.set(this, (d = {}));
  return d;
}
const N = {
  winDocument,
  getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  defineProperty: Object.defineProperty,
  getPrototypeOf: Object.getPrototypeOf,
  fnToString: Function.prototype.toString,
  apply: Reflect.apply,
  Proxy,
} as unknown as Natives;

/** A page realm whose History-like prototype records the URL the engine's hook would rewrite (Scramjet: String(url)). */
function page() {
  const ctx = vm.createContext({});
  const run = <T,>(code: string): T => vm.runInContext(code, ctx) as T;
  run(`
    globalThis.seen = [];
    globalThis.HistoryProto = {
      pushState: function pushState(state, title, url) { seen.push('push ' + String(url) + ' ' + arguments.length); },
      replaceState: function replaceState(state, title, url) { seen.push('replace ' + String(url) + ' ' + arguments.length); },
    };`);
  const win = run<Window>('globalThis');
  return { run, win, proto: run<object>('HistoryProto') };
}

describe('History URL fix (Scramjet pushState/replaceState without a URL)', () => {
  it('gives a call without a URL, or with undefined/null, the document’s real URL', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    let current: string | null = 'https://duckduckgo.com/?q=gnome';
    expect(wrapHistoryUrl(N, kit, p.proto, () => current)).toBe(2);
    p.run(`HistoryProto.replaceState({ a: 1 }, '');
      HistoryProto.pushState({ b: 2 }, '', undefined);
      HistoryProto.replaceState(null, '', null);
      HistoryProto.pushState({}, '', '/next?x=1');
      HistoryProto.replaceState({}, '', '');`);
    current = null; // GNOME cannot tell: the call is left as the page made it
    p.run(`HistoryProto.pushState({}, '');`);
    expect(p.run<string[]>('seen')).toEqual([
      'replace https://duckduckgo.com/?q=gnome 3',
      'push https://duckduckgo.com/?q=gnome 3',
      'replace https://duckduckgo.com/?q=gnome 3',
      'push /next?x=1 3',
      'replace  3',
      'push undefined 2',
    ]);
  });

  it('installs page-realm callables only', () => {
    const p = page();
    wrapHistoryUrl(N, pageKit(p.win, N)!, p.proto, () => 'https://a.example/');
    expect(p.run('HistoryProto.pushState.constructor === Function')).toBe(true);
    expect(p.run('Object.getPrototypeOf(HistoryProto.replaceState) === Function.prototype')).toBe(true);
  });
});
