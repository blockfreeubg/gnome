// ScramjetEngine.decode (worklist A14): Scramjet's unrewriteUrl is called only with the context of the frame that owns
// the URL's prefix. Called with another context it logs "unrewriteurl: unexpected url" (console.error, seen in the
// visual QA of /browse) and hands back the proxied URL as if it were the real one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScramjetEngine } from './scramjet';
import type { ScramjetControllerLike, ScramjetFrameLike } from './vendor';

const ORIGIN = 'http://127.0.0.1:27201';
const frame = (controller: string, id: string): ScramjetFrameLike => {
  const prefix = `/~/sj/${controller}/${id}/`;
  return { prefix, context: { prefix: new URL(prefix, ORIGIN) } } as unknown as ScramjetFrameLike;
};
const proxied = (f: ScramjetFrameLike, real: string): URL => new URL(`${f.prefix}${encodeURIComponent(real)}`, ORIGIN);

/** Scramjet 2.0.67-alpha.2's unrewriteUrl for http(s) URLs: the context's prefix, else console.error + the input. */
function fakeScramjet(errors: unknown[][]) {
  return {
    unrewriteUrl(url: string, ctx: { prefix: URL }): string {
      if (!url.startsWith(ctx.prefix.href)) {
        errors.push(['unrewriteurl: unexpected url', url]);
        return url;
      }
      return decodeURIComponent(new URL(url).pathname.slice(ctx.prefix.pathname.length));
    },
  };
}

describe('ScramjetEngine.decode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function engine(frames: ScramjetFrameLike[]): { e: ScramjetEngine; errors: unknown[][] } {
    const errors: unknown[][] = [];
    vi.stubGlobal('window', { $scramjet: fakeScramjet(errors) });
    const e = new ScramjetEngine('2.0.67-alpha.2', true);
    e.controller = { frames } as unknown as ScramjetControllerLike;
    return { e, errors };
  }

  it("decodes the tab frame's own URLs with its context", () => {
    const a = frame('c1', 'fa');
    const { e, errors } = engine([a]);
    expect(e.decode(proxied(a, 'https://example.com/a?b=1'), a)).toBe('https://example.com/a?b=1');
    expect(errors).toEqual([]);
  });

  it("uses the frame that owns the prefix when it is not the tab's (no console.error)", () => {
    const a = frame('c1', 'fa');
    const b = frame('c1', 'fb');
    const { e, errors } = engine([a, b]);
    expect(e.decode(proxied(b, 'https://example.org/'), a)).toBe('https://example.org/');
    expect(e.decode(proxied(b, 'https://example.org/x'), null)).toBe('https://example.org/x');
    expect(errors).toEqual([]);
  });

  it("decodes a URL no frame of this engine host owns (an earlier engine host's) with the codec, not as itself", () => {
    const a = frame('c1', 'fa');
    const stale = frame('c0', 'old');
    const { e, errors } = engine([a]);
    const raw = proxied(stale, 'https://en.wikipedia.org/wiki/Gnome');
    expect(e.decode(raw, a)).toBe('https://en.wikipedia.org/wiki/Gnome');
    expect(e.decode(raw, null)).toBe('https://en.wikipedia.org/wiki/Gnome');
    expect(errors).toEqual([]);
  });
});

describe('ScramjetEngine.wrapRequests', () => {
  it('passes every controller request through withInitiator, GNOME loads included', async () => {
    const seen: unknown[] = [];
    const methods: Record<string, ((a: unknown) => Promise<unknown>) | undefined> = {
      request: async (a) => {
        seen.push(a);
        return 'answer';
      },
    };
    const e = new ScramjetEngine('2.0.67-alpha.2', true);
    const c = { frames: [], methods } as unknown as ScramjetControllerLike;
    let now = 5000;
    e.wrapRequests(c, () => now);
    const host = `${ORIGIN}/engine/`;
    const a = frame('c1', 'fa');
    await expect(methods.request!({ rawUrl: proxied(a, 'https://x.example/').href, rawClientUrl: host, mode: 'navigate', destination: 'iframe' })).resolves.toBe('answer');
    expect((seen[0] as { rawClientUrl?: string }).rawClientUrl).toBeUndefined();
    const target = proxied(a, 'https://y.example/').href;
    e.gnomeLoads.expect(target, now);
    now += 100;
    const prev = proxied(a, 'https://x.example/').href;
    await methods.request!({ rawUrl: target, rawClientUrl: prev, rawReferrer: prev, mode: 'navigate', destination: 'iframe' });
    expect(seen[1]).toMatchObject({ rawUrl: target, rawClientUrl: undefined, rawReferrer: '' });
    // A tab a page asked for: the opener is the initiator; a fetch the engine host makes for a page: the page is.
    const opened = proxied(a, 'https://victim.example/').href;
    const opener = proxied(a, 'https://attacker.example/').href;
    e.gnomeLoads.expect(opened, now, opener);
    await methods.request!({ rawUrl: opened, rawClientUrl: host, mode: 'navigate', destination: 'iframe' });
    expect(seen[2]).toMatchObject({ rawUrl: opened, rawClientUrl: opener, rawReferrer: opener });
    const icon = proxied(a, 'https://victim.example/favicon.ico').href;
    e.pageFetches.expect(icon, now, opener);
    await methods.request!({ rawUrl: icon, rawClientUrl: host, mode: 'no-cors', destination: 'image' });
    expect(seen[3]).toMatchObject({ rawUrl: icon, rawClientUrl: opener });
    now += 30_000; // both are forgotten after the navigation timeout
    await methods.request!({ rawUrl: icon, rawClientUrl: host, mode: 'no-cors', destination: 'image' });
    expect((seen[4] as { rawClientUrl?: string }).rawClientUrl).toBeUndefined();
  });

  it('leaves a controller without methods.request alone', () => {
    const e = new ScramjetEngine('2.0.67-alpha.2', true);
    const c = { frames: [] } as unknown as ScramjetControllerLike;
    expect(() => e.wrapRequests(c)).not.toThrow();
    expect((c as { methods?: unknown }).methods).toBeUndefined();
  });
});
