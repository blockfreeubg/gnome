import { describe, expect, it } from 'vitest';
import { TIMEOUTS } from '../shared/engine-protocol';
import { GnomeLoads, TabRequestClaims, UNNAMED_EXPECT_MS, requestKey, tabShaped, withInitiator } from './sj-requests';

const SJ = 'http://127.0.0.1:27201/~/sj/c1/f1/';
const enc = (u: string): string => SJ + encodeURIComponent(u);
const HOOKED = { hookedDocument: true, pendingUrl: null, realUrl: null };

describe('Scramjet tab-frame request claims', () => {
  it('knows the tab-shaped requests (document/iframe without the $iframe first-load mark)', () => {
    expect(tabShaped('iframe', enc('https://a.example/'))).toBe(true);
    expect(tabShaped('document', enc('https://a.example/'))).toBe(true);
    expect(tabShaped('iframe', `${enc('https://a.example/')}?$iframe=1&$tf=tab-1`)).toBe(false);
    expect(tabShaped('script', enc('https://a.example/x.js'))).toBe(false);
    expect(tabShaped('iframe', 'not a url')).toBe(false);
    expect(requestKey('https://a.example/p?q#frag')).toBe('https://a.example/p?q');
    expect(requestKey('nope')).toBeNull();
  });

  it('claims a GNOME load by its URL and leaves a nested frame navigation alone', () => {
    const c = new TabRequestClaims();
    c.expect(enc('https://a.example/'), 1000);
    // A nested frame navigating meanwhile (same shape, another URL) is not the tab's.
    expect(c.claim(enc('https://ads.example/frame'), 1001, HOOKED)).toBe(false);
    expect(c.claim(`${enc('https://a.example/')}#top`, 1002, HOOKED)).toBe(true);
    expect(c.isOwn(enc('https://a.example/'))).toBe(true);
    // The expectation was used up: the next nested navigation is not claimed.
    expect(c.claim(enc('https://a.example/'), 1003, HOOKED)).toBe(false);
  });

  it('follows the redirect hops of the tab frame only', () => {
    const c = new TabRequestClaims();
    c.expect(enc('https://a.example/start'), 0);
    expect(c.claim(enc('https://a.example/start'), 10, HOOKED)).toBe(true);
    // The 3xx answer names the next hop; a nested iframe's own redirect hop does not match it.
    c.expect(enc('https://a.example/landing'), 20);
    expect(c.claim(enc('https://cdn.example/redirected-iframe'), 25, HOOKED)).toBe(false);
    expect(c.claim(enc('https://a.example/landing'), 30, HOOKED)).toBe(true);
  });

  it('takes the first request after beforeunload, unless a fresh expectation names the URL', () => {
    const c = new TabRequestClaims();
    c.expect(null, 0);
    expect(c.claim(enc('https://b.example/'), 5, HOOKED)).toBe(true);
    // navigate (with the URL) then beforeunload (without) for one navigation: the URL wins.
    c.expect(enc('https://c.example/'), 100);
    c.expect(null, 101);
    expect(c.claim(enc('https://nested.example/'), 102, HOOKED)).toBe(false);
    expect(c.claim(enc('https://c.example/'), 103, HOOKED)).toBe(true);
    // A URL-less expectation replaces an old one.
    c.expect(enc('https://d.example/'), 200);
    c.expect(null, 1300);
    expect(c.claim(enc('https://e.example/'), 1301, HOOKED)).toBe(true);
  });

  it('expires and can be cleared', () => {
    const c = new TabRequestClaims();
    c.expect(null, 0);
    expect(c.claim(enc('https://late.example/'), UNNAMED_EXPECT_MS + 1, HOOKED)).toBe(false);
    c.expect(enc('https://slow.example/'), 0);
    expect(c.claim(enc('https://slow.example/'), UNNAMED_EXPECT_MS + 1, HOOKED)).toBe(true);
    c.expect(enc('https://slow.example/'), 0);
    expect(c.claim(enc('https://slow.example/'), TIMEOUTS.navigationMs + 1, HOOKED)).toBe(false);
    c.expect(null, 0);
    c.clear();
    expect(c.claim(enc('https://x.example/'), 1, HOOKED)).toBe(false);
  });

  it('claims everything in a frame without a hooked document, and the pending navigation\'s destination', () => {
    const c = new TabRequestClaims();
    expect(c.claim(enc('https://first.example/'), 0, { hookedDocument: false, pendingUrl: null, realUrl: null })).toBe(true);
    expect(c.claim(enc('https://p.example/x'), 0, { hookedDocument: true, pendingUrl: 'https://p.example/x#h', realUrl: 'https://p.example/x' })).toBe(true);
    expect(c.claim(enc('https://p.example/y'), 0, { hookedDocument: true, pendingUrl: 'https://p.example/x', realUrl: 'https://p.example/y' })).toBe(false);
    expect(c.claim('::', 0, { hookedDocument: false, pendingUrl: null, realUrl: null })).toBe(false);
  });
});

describe('the initiator Scramjet sees (withInitiator, GnomeLoads)', () => {
  const HOST = 'http://127.0.0.1:27201/engine/';
  const nav = (rawUrl: string, client: string | undefined, referrer = '') => ({
    rawUrl,
    rawClientUrl: client,
    rawReferrer: referrer,
    referrer,
    mode: 'navigate',
    destination: 'iframe',
    method: 'GET',
  });
  const none = (): undefined => undefined;

  it("drops a client that is no Scramjet document (the engine host's own loads)", () => {
    const r = withInitiator(nav(enc('https://a.example/'), HOST), none);
    expect(r.rawClientUrl).toBeUndefined();
    expect(r.rawUrl).toBe(enc('https://a.example/'));
    // a subresource of the engine host's own document too, whatever the mode
    expect(withInitiator({ rawUrl: enc('https://a.example/x.js'), rawClientUrl: HOST, mode: 'no-cors', destination: 'script' }, none).rawClientUrl).toBeUndefined();
  });

  it('keeps the client of a page-initiated request (its Referer and Origin are the page’s to send)', () => {
    const page = enc('https://a.example/page');
    const req = nav(enc('https://b.example/'), page, page);
    expect(withInitiator(req, none)).toBe(req);
    const sub = { rawUrl: enc('https://b.example/x.png'), rawClientUrl: page, mode: 'no-cors', destination: 'image' };
    expect(withInitiator(sub, () => null)).toBe(sub); // never for subresources
    expect(withInitiator(sub, none, () => enc('https://c.example/'))).toBe(sub); // nor the engine host's on-behalf rule
    const blank = { rawUrl: enc('https://b.example/y.png'), rawClientUrl: 'about:blank', mode: 'no-cors', destination: 'image' };
    expect(withInitiator(blank, none)).toBe(blank);
  });

  it('drops the initiator of a GNOME-initiated navigation (Chromium names the previous page as its client)', () => {
    const previous = enc('https://a.example/page');
    const r = withInitiator(nav(enc('https://b.example/'), previous, previous), (raw) => (raw === enc('https://b.example/') ? null : undefined));
    expect(r.rawClientUrl).toBeUndefined();
    expect(r.rawReferrer).toBe('');
    expect(r.referrer).toBe('');
    expect(r.method).toBe('GET');
  });

  it('gives a tab a page asked for that page as its initiator, as after a link click (security review)', () => {
    const opener = enc('https://attacker.example/page');
    const target = enc('https://victim.example/landing');
    // The engine host's location.replace into a fresh frame: its client is the engine host, or the previous page.
    for (const client of [HOST, enc('https://previous.example/'), undefined]) {
      const r = withInitiator(nav(target, client, client ?? ''), (raw) => (raw === target ? opener : undefined));
      expect(r).toMatchObject({ rawUrl: target, rawClientUrl: opener, rawReferrer: opener, referrer: opener });
    }
  });

  it("makes the page the initiator of what the engine host fetches for it (favicon, a download it started)", () => {
    const page = enc('https://attacker.example/page');
    const icon = enc('https://victim.example/transfer?via=favicon');
    const onBehalf = (raw: string): string | undefined => (raw === icon ? page : undefined);
    const r = withInitiator({ rawUrl: icon, rawClientUrl: HOST, rawReferrer: '', referrer: '', mode: 'no-cors', destination: 'image' }, none, onBehalf);
    expect(r).toMatchObject({ rawClientUrl: page, rawReferrer: page, referrer: page });
    const dl = withInitiator({ rawUrl: icon, rawClientUrl: HOST, mode: 'cors', destination: '' }, none, onBehalf);
    expect(dl.rawClientUrl).toBe(page);
    // Anything else the engine host fetches still has no initiator, and a navigation never takes this rule.
    expect(withInitiator({ rawUrl: enc('https://victim.example/other'), rawClientUrl: HOST, mode: 'no-cors', destination: 'image' }, none, onBehalf).rawClientUrl).toBeUndefined();
    expect(withInitiator(nav(icon, HOST), none, onBehalf).rawClientUrl).toBeUndefined();
  });

  it('keeps the initiator of a remembered load across its redirects', () => {
    const loads = new GnomeLoads();
    const opener = enc('https://attacker.example/page');
    loads.expect(enc('https://v.example/a'), 1000, opener);
    loads.expect(enc('https://g.example/'), 1000);
    expect(loads.initiatorOf(enc('https://v.example/a'), 1001)).toBe(opener);
    expect(loads.initiatorOf(enc('https://g.example/'), 1001)).toBeNull();
    expect(loads.initiatorOf(enc('https://nope.example/'), 1001)).toBeUndefined();
    loads.redirected(enc('https://v.example/a'), enc('https://v.example/b'), 1100);
    expect(loads.initiatorOf(enc('https://v.example/b'), 1200)).toBe(opener);
    loads.redirected(enc('https://g.example/'), enc('https://g2.example/'), 1100);
    expect(loads.initiatorOf(enc('https://g2.example/'), 1200)).toBeNull();
  });

  it('remembers GNOME loads for the navigation timeout and follows their redirects', () => {
    const loads = new GnomeLoads();
    loads.expect(`${enc('https://a.example/')}#frag`, 1000);
    expect(loads.has(enc('https://a.example/'), 1001)).toBe(true);
    expect(loads.has(enc('https://other.example/'), 1001)).toBe(false);
    loads.redirected(enc('https://a.example/'), `${enc('https://www.a.example/')}?$rfs=`, 1500);
    expect(loads.has(`${enc('https://www.a.example/')}?$rfs=`, 1600)).toBe(true);
    loads.redirected(enc('https://not-gnome.example/'), enc('https://elsewhere.example/'), 1600); // a page's redirect
    expect(loads.has(enc('https://elsewhere.example/'), 1700)).toBe(false);
    expect(loads.has(enc('https://a.example/'), 1000 + TIMEOUTS.navigationMs + 1)).toBe(false);
    loads.expect(enc('https://c.example/'), 1000 + TIMEOUTS.navigationMs * 3); // prunes the old ones
    expect(loads.size).toBe(1);
  });
});
