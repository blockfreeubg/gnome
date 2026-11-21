/** An in-memory CacheStorage for the cache's unit tests (node has Request and Response, not caches). */
export class MemoryCache {
  readonly entries = new Map<string, { body: ArrayBuffer; type: string }>();
  failPuts = false;
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const e = this.entries.get(String(typeof req === 'object' && 'url' in req ? req.url : req));
    return e ? new Response(e.body.slice(0), { headers: { 'content-type': e.type } }) : undefined;
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    if (this.failPuts) throw new DOMException('quota', 'QuotaExceededError');
    this.entries.set(String(typeof req === 'object' && 'url' in req ? req.url : req), { body: await res.arrayBuffer(), type: res.headers.get('content-type') ?? '' });
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(String(typeof req === 'object' && 'url' in req ? req.url : req));
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
}

export class MemoryCaches {
  readonly caches = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new MemoryCache()));
    return c;
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async match(): Promise<undefined> {
    return undefined;
  }
}
