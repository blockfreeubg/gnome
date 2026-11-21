import { describe, expect, it } from 'vitest';
import { validateEventPayload } from '../shared/engine-protocol';
import type { EventMap } from '../shared/engine-protocol';
import { DownloadTracker, contentLength, namedDisposition } from './downloads';

describe('namedDisposition (the name the browser saves a proxied download under)', () => {
  it("names a download without a file name after the real URL's last segment, not the proxied URL", () => {
    expect(namedDisposition(null, 'unrendered-type', 'https://proof.ovh.net/files/1Mb.dat')).toBe(`inline; filename="1Mb.dat"; filename*=UTF-8''1Mb.dat`);
    expect(namedDisposition('attachment', 'attachment', 'https://a.example/dl/report%20final.pdf?x=1')).toBe(
      `attachment; filename="report final.pdf"; filename*=UTF-8''report%20final.pdf`,
    );
    expect(namedDisposition('ATTACHMENT ; size=3', 'attachment', 'https://a.example/x/')).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
    // Non-ASCII and quote characters: percent-encoded in filename*, replaced in the ASCII fallback.
    expect(namedDisposition(null, 'unrendered-type', 'https://a.example/%C3%A9t%C3%A9%22x%22.zip')).toBe(
      `inline; filename="_t__x_.zip"; filename*=UTF-8''%C3%A9t%C3%A9%22x%22.zip`,
    );
  });

  it('leaves a header that already names the file alone', () => {
    expect(namedDisposition('attachment; filename="attach.bin"', 'attachment', 'https://a.example/x')).toBeNull();
    expect(namedDisposition("attachment; filename*=UTF-8''%E2%82%AC.txt", 'attachment', 'https://a.example/x')).toBeNull();
    expect(namedDisposition('inline;filename=a.zip', 'unrendered-type', 'https://a.example/b.zip')).toBeNull();
  });
});

type Dl = 'download.started' | 'download.progress' | 'download.done';

function tracker() {
  const events: Array<{ type: Dl; p: unknown }> = [];
  const forgot: string[] = [];
  const t = new DownloadTracker({
    emit: <T extends Dl>(type: T, p: EventMap[T]) => {
      const v = validateEventPayload(type, p);
      if (!v.ok) throw new Error(`${type}: ${v.error}`);
      events.push({ type, p });
    },
    forget: (id) => forgot.push(id),
  });
  return { t, events, forgot };
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!stream) return -1;
  let n = 0;
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return n;
    n += value.byteLength;
  }
}

describe('DownloadTracker', () => {
  it('reports a Scramjet attachment: started, progress, completed', async () => {
    const { t, events, forgot } = tracker();
    const body = new Response(new Uint8Array(3000)).body;
    const s = t.trackScramjet(3, { url: 'https://a.example/f/report.pdf?x=1', contentDisposition: 'attachment; filename="Q3 report.pdf"', contentType: 'application/pdf; charset=binary', contentLength: '3000' }, body, null);
    expect(await drain(s)).toBe(3000);
    expect(events[0]).toEqual({ type: 'download.started', p: { downloadId: 'sj-1', tabId: 3, url: 'https://a.example/f/report.pdf?x=1', filename: 'Q3 report.pdf', mime: 'application/pdf', total: 3000, engine: 'scramjet' } });
    expect(events.at(-1)).toEqual({ type: 'download.done', p: { downloadId: 'sj-1', state: 'completed', received: 3000, error: null } });
    expect(forgot).toEqual(['sj-1']);
  });

  it('holds an unrendered-type download until the navigation decides', async () => {
    const { t, events } = tracker();
    const nav = {};
    const s = t.trackScramjet(1, { url: 'https://a.example/a.zip', contentDisposition: null, contentType: 'application/zip', contentLength: null }, new Uint8Array(10), { nav });
    await drain(s);
    expect(events).toHaveLength(0);
    t.release(nav);
    expect(events.map((e) => e.type)).toEqual(['download.started', 'download.done']);
    expect(events[1]?.p).toMatchObject({ state: 'completed', received: 10 });
    // A held download whose navigation committed is dropped silently.
    const nav2 = {};
    const s2 = t.trackScramjet(1, { url: 'https://a.example/b.md', contentDisposition: null, contentType: 'text/markdown', contentLength: null }, 'text', { nav: nav2 });
    t.drop(nav2);
    await drain(s2);
    expect(events).toHaveLength(2);
  });

  it('reports a cancelled stream', async () => {
    const { t, events } = tracker();
    const s = t.trackScramjet(1, { url: 'https://a.example/x.bin', contentDisposition: 'attachment', contentType: null, contentLength: '5' }, new Uint8Array(5), null);
    await s?.cancel('user');
    expect(events.at(-1)?.p).toMatchObject({ state: 'cancelled' });
  });

  it('claims UV signals only through the claim function, and forwards later phases', () => {
    const { t, events } = tracker();
    const base = { type: 'uv-download' as const, url: '/uv/service/x', referrer: null, clientUrl: null, navigation: true, disposition: 'attachment' as const, filename: 'a/b.bin', mime: 'application/octet-stream', total: 4 };
    t.onUvSignal({ ...base, phase: 'started', id: 'uv-1' }, () => null);
    t.onUvSignal({ type: 'uv-download', phase: 'done', id: 'uv-1', state: 'completed', received: 4, error: null }, () => null);
    expect(events).toHaveLength(0);
    expect(t.ignoredUv).toBe(1);
    t.onUvSignal({ ...base, phase: 'started', id: 'uv-2' }, () => ({ tabId: 9, nav: null, held: false, url: 'https://a.example/b.bin' }));
    t.onUvSignal({ type: 'uv-download', phase: 'progress', id: 'uv-2', received: 2, total: 4 }, () => null);
    t.onUvSignal({ type: 'uv-download', phase: 'done', id: 'uv-2', state: 'failed', received: 2, error: 'stream ‮error' }, () => null);
    expect(events.map((e) => e.type)).toEqual(['download.started', 'download.progress', 'download.done']);
    expect(events[0]?.p).toMatchObject({ tabId: 9, filename: 'a_b.bin', engine: 'ultraviolet' });
    expect(events[2]?.p).toMatchObject({ state: 'failed', error: 'stream error' });
  });

  it("reports the SW's final byte count, not the last (throttled) progress value", () => {
    const { t, events } = tracker();
    const base = { type: 'uv-download' as const, url: '/uv/service/x', referrer: null, clientUrl: null, navigation: true, disposition: 'attachment' as const, filename: 'z.zip', mime: null, total: 2097152 };
    t.onUvSignal({ ...base, phase: 'started', id: 'uv-3' }, () => ({ tabId: 1, nav: null, held: false, url: 'https://a.example/z.zip' }));
    t.onUvSignal({ type: 'uv-download', phase: 'progress', id: 'uv-3', received: 1982464, total: 2097152 }, () => null);
    t.onUvSignal({ type: 'uv-download', phase: 'done', id: 'uv-3', state: 'completed', received: 2097152, error: null }, () => null);
    expect(events.at(-1)).toMatchObject({ type: 'download.done', p: { downloadId: 'uv-3', state: 'completed', received: 2097152 } });
  });

  it('reads Content-Length strictly', () => {
    expect(contentLength('42')).toBe(42);
    expect(contentLength(' 7 ')).toBe(7);
    expect(contentLength('-1')).toBeNull();
    expect(contentLength('1e3')).toBeNull();
    expect(contentLength(null)).toBeNull();
  });
});
