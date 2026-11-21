/**
 * Downloads (ENGINE-PROTOCOL §6.9). The browser's own download manager saves them (the engine iframe has
 * `allow-downloads`); the engine host reports them. Scramjet: its per-tab plugin sees each response, so the tab is
 * exact and the body is wrapped in a counting stream here. Ultraviolet: the service worker taps the responses and
 * sends `uv-download` signals to every engine-host client; this host claims one for one of its own tabs only on an
 * exact match (the pending navigation's URL, then the requesting client's URL, then the referrer) and ignores the
 * rest (another GNOME tab may own it).
 *
 * An `attachment` is a download at once. An `unrendered-type` navigation is held: download.started goes out only when
 * no document commits for it within TIMEOUTS.downloadCommitMs (the browser rendered it otherwise); bytes counted in
 * the meantime are reported with it.
 */
import { LIMITS, fitText, sanitizeText } from '../shared/engine-protocol';
import type { EngineId, EventMap, TabId } from '../shared/engine-protocol';
import { bareMime, downloadFilename } from '../shared/proxy-origin';
import type { DownloadDisposition, SwSignal } from '../shared/proxy-origin';
import { reportUrl } from './history';

export interface DownloadEnv {
  emit<T extends 'download.started' | 'download.progress' | 'download.done'>(type: T, p: EventMap[T]): void;
  forget(downloadId: string): void;
}

interface Record_ {
  id: string;
  tabId: TabId;
  url: string;
  filename: string;
  mime: string | null;
  total: number | null;
  engine: EngineId;
  /** Waiting for the navigation to decide (unrendered type). */
  held: boolean;
  /** The navigation object this download belongs to (held downloads are released or dropped with it). */
  nav: object | null;
  received: number;
  done: { state: 'completed' | 'failed' | 'cancelled'; error: string | null } | null;
}

/** A Content-Length header as a byte count, or null. */
/**
 * The `Content-Disposition` a proxied download response needs so the BROWSER saves it under its real name, or null
 * when it already has one. Without a file name in the header the browser names the file after the last segment of
 * the URL it fetched, and a Scramjet URL's last segment is the whole encoded real URL (Chromium and Firefox saved
 * `https://proof.ovh.net/files/1Mb.dat` as `https___proof.ovh.net_files_1Mb.dat` while GNOME's list showed `1Mb.dat`;
 * integration part 2). `attachment` keeps its disposition type and gains the name; an unrendered type gets `inline`
 * with the name, so the browser still decides itself whether it renders the type (it downloads what it cannot).
 * The name is downloadFilename's, as `filename*` (RFC 6266/8187) with an ASCII `filename` beside it.
 */
export function namedDisposition(contentDisposition: string | null, disposition: DownloadDisposition, realUrl: string): string | null {
  if (contentDisposition !== null && /(?:^|;)\s*filename\*?\s*=/i.test(contentDisposition)) return null;
  const name = downloadFilename(null, realUrl);
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition === 'attachment' ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function contentLength(v: string | null): number | null {
  if (v === null || !/^\s*\d{1,15}\s*$/.test(v)) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) ? n : null;
}

export class DownloadTracker {
  readonly #env: DownloadEnv;
  readonly #records = new Map<string, Record_>();
  #seq = 0;
  /** download.started sent (diagnostics). */
  started = 0;
  /** UV signals no tab of this host matched (another GNOME tab, or no exact match). */
  ignoredUv = 0;

  constructor(env: DownloadEnv) {
    this.#env = env;
  }

  /**
   * Scramjet: a response the browser will download. Returns the body to hand back to Scramjet (a counting stream).
   * `held`: an unrendered-type navigation (released by release(nav) or dropped by drop(nav)).
   */
  trackScramjet(
    tabId: TabId,
    info: { url: string; contentDisposition: string | null; contentType: string | null; contentLength: string | null },
    body: unknown,
    held: { nav: object } | null,
  ): ReadableStream<Uint8Array> | null {
    const url = reportUrl(info.url);
    if (!url) return null;
    const id = `sj-${++this.#seq}`;
    const rec: Record_ = {
      id,
      tabId,
      url,
      filename: downloadFilename(info.contentDisposition, info.url),
      mime: bareMime(info.contentType),
      total: contentLength(info.contentLength),
      engine: 'scramjet',
      held: !!held,
      nav: held?.nav ?? null,
      received: 0,
      done: null,
    };
    this.#records.set(id, rec);
    if (!rec.held) this.#start(rec);
    return countingStream(
      body,
      (received) => this.#progress(rec, received),
      (state, error) => this.#finish(rec, state, error),
    );
  }

  /** An unrendered-type navigation committed no document in time: its downloads are real. */
  release(nav: object): void {
    for (const rec of this.#records.values()) {
      if (rec.nav !== nav || !rec.held) continue;
      rec.held = false;
      this.#start(rec);
      if (rec.received > 0 && !rec.done) this.#env.emit('download.progress', { downloadId: rec.id, received: rec.received, total: rec.total });
      if (rec.done) this.#emitDone(rec);
    }
  }

  /** It committed after all: the browser rendered it, nothing was downloaded. */
  drop(nav: object): void {
    for (const [id, rec] of this.#records) if (rec.nav === nav && rec.held) this.#records.delete(id);
  }

  /**
   * Ultraviolet: a SW signal. `claim` maps a `started` signal to one of this host's tabs (null: not ours) and says
   * whether it is held (an unrendered-type navigation of a pending tab navigation) and by which navigation.
   */
  onUvSignal(sig: Extract<SwSignal, { type: 'uv-download' }>, claim: (s: Extract<SwSignal, { phase: 'started' }>) => { tabId: TabId; nav: object | null; held: boolean; url: string } | null): void {
    if (sig.phase === 'started') {
      const c = claim(sig);
      if (!c) {
        this.ignoredUv++;
        return;
      }
      const url = reportUrl(c.url);
      if (!url) return;
      const rec: Record_ = {
        id: sig.id,
        tabId: c.tabId,
        url,
        filename: fitFilename(sig.filename, c.url),
        mime: sig.mime === null ? null : bareMime(sig.mime),
        total: sig.total,
        engine: 'ultraviolet',
        held: c.held,
        nav: c.nav,
        received: 0,
        done: null,
      };
      if (this.#records.has(rec.id)) return;
      this.#records.set(rec.id, rec);
      if (!rec.held) this.#start(rec);
      return;
    }
    const rec = this.#records.get(sig.id);
    if (!rec || rec.engine !== 'ultraviolet') return;
    if (sig.phase === 'progress') this.#progress(rec, sig.received);
    else {
      // The SW counted every byte it passed on: its final count is the truth (progress signals are throttled, so the
      // last one is usually short of it).
      if (!rec.done) rec.received = Math.max(rec.received, Math.floor(sig.received));
      this.#finish(rec, sig.state, sig.error);
    }
  }

  /**
   * A download the engine host performs itself (an `<a download>` link: Chromium sends those requests past the
   * service worker, straight to the server, so they never reach an engine): the proxied URL is fetched in the
   * engine-host realm (through the SW and the tab's engine, with the site's cookies), counted, and handed to the
   * browser as a blob download. The whole file is held in memory until the browser takes it.
   */
  async fetchDownload(
    tabId: TabId,
    engine: EngineId,
    proxiedUrl: string,
    realUrl: string,
    name: string | null,
    io: { fetch: typeof fetch; save: (blob: Blob, filename: string) => void },
  ): Promise<void> {
    const url = reportUrl(realUrl);
    if (!url) return;
    const res = await io.fetch(proxiedUrl, { credentials: 'same-origin', cache: 'no-store' });
    const cd = res.headers.get('content-disposition');
    const filename = name && name.trim() ? downloadFilename(`attachment; filename*=UTF-8''${encodeURIComponent(name.trim())}`, realUrl) : downloadFilename(cd, realUrl);
    const rec: Record_ = {
      id: `dl-${++this.#seq}`,
      tabId,
      url,
      filename,
      mime: bareMime(res.headers.get('content-type')),
      total: contentLength(res.headers.get('content-length')),
      engine,
      held: false,
      nav: null,
      received: 0,
      done: null,
    };
    this.#records.set(rec.id, rec);
    this.#start(rec);
    const chunks: Uint8Array[] = [];
    try {
      const body = countingStream(res.body, (n) => this.#progress(rec, n), () => {});
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      io.save(new Blob(chunks as BlobPart[], { type: rec.mime ?? 'application/octet-stream' }), filename);
      this.#finish(rec, 'completed', null);
    } catch (err) {
      this.#finish(rec, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  /** download ids this host reported (for tests). */
  get size(): number {
    return this.#records.size;
  }

  #start(rec: Record_): void {
    this.started++;
    this.#env.emit('download.started', {
      downloadId: rec.id,
      tabId: rec.tabId,
      url: rec.url,
      filename: rec.filename,
      mime: rec.mime,
      total: rec.total,
      engine: rec.engine,
    });
  }

  #progress(rec: Record_, received: number): void {
    rec.received = Math.max(0, Math.floor(received));
    if (rec.held || rec.done) return;
    this.#env.emit('download.progress', { downloadId: rec.id, received: rec.received, total: rec.total });
  }

  #finish(rec: Record_, state: 'completed' | 'failed' | 'cancelled', error: string | null): void {
    if (rec.done) return;
    rec.done = { state, error: error === null ? null : fitText(sanitizeText(error), LIMITS.maxDetailLength) };
    if (rec.held) return;
    this.#emitDone(rec);
  }

  #emitDone(rec: Record_): void {
    const done = rec.done;
    if (!done) return;
    this.#env.emit('download.done', { downloadId: rec.id, state: done.state, received: rec.received, error: done.error });
    this.#records.delete(rec.id);
    this.#env.forget(rec.id);
  }
}

function fitFilename(name: string, url: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').replace(/[/\\]/g, '_').trim();
  return clean && clean !== '.' && clean !== '..' ? fitText(clean, LIMITS.maxFilenameLength) : downloadFilename(null, url);
}

/** Wraps a response body so its bytes are counted and its end (completed, failed, cancelled) is seen. */
export function countingStream(
  body: unknown,
  onProgress: (received: number) => void,
  onDone: (state: 'completed' | 'failed' | 'cancelled', error: string | null) => void,
): ReadableStream<Uint8Array> {
  const source: ReadableStream<Uint8Array> =
    body instanceof ReadableStream ? (body as ReadableStream<Uint8Array>) : (new Response(body as BodyInit | null).body ?? new ReadableStream({ start: (c) => c.close() }));
  const reader = source.getReader();
  let received = 0;
  let finished = false;
  const finish = (state: 'completed' | 'failed' | 'cancelled', error: string | null): void => {
    if (finished) return;
    finished = true;
    onDone(state, error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish('completed', null);
          return;
        }
        received += value.byteLength;
        onProgress(received);
        controller.enqueue(value);
      } catch (err) {
        finish('failed', err instanceof Error ? err.message : String(err));
        controller.error(err);
      }
    },
    cancel(reason) {
      finish('cancelled', null);
      return reader.cancel(reason);
    },
  });
}

export type { DownloadDisposition };
