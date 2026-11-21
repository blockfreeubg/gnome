// cookies.list / cookies.delete over both jars (cookie-ops.ts) with a fake Scramjet controller and an in-memory
// IndexedDB holding Ultraviolet's `__op` database.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteCookies, listCookies, purgeExpiredCookies } from './cookie-ops';
import { readUvCookies, writeUvCookies } from './cookies';
import type { ScramjetCookie, UvCookieRow } from './cookies';
import type { EngineManager } from './engines/manager';

function fakeEngines(jar: Record<string, ScramjetCookie>) {
  const synced: Array<{ lines: unknown[]; clear: boolean }> = [];
  let persisted = 0;
  let state = JSON.stringify(jar);
  const controller = {
    cookieJar: {
      dump: () => state,
      load: (s: string) => {
        state = s;
      },
    },
    persistCookies: async () => {
      persisted++;
    },
    propagateCookieSync: async (lines: unknown[], opts: { clear: boolean }) => {
      synced.push({ lines, clear: opts.clear });
    },
  };
  const scramjet = {
    controller,
    jar: () => JSON.parse(state) as Record<string, ScramjetCookie>,
    setJar: async (j: Record<string, ScramjetCookie>) => {
      state = JSON.stringify(j);
      await controller.persistCookies();
    },
  };
  return { engines: { scramjet } as unknown as EngineManager, synced, persisted: () => persisted, jar: () => JSON.parse(state) as Record<string, ScramjetCookie> };
}

const now = Date.now();
const sj = (name: string, domain: string, expires?: number): ScramjetCookie => ({ name, value: 'v', domain, path: '/', ...(expires === undefined ? {} : { expires }) });
const uv = (name: string, domain: string, extra: Partial<UvCookieRow> = {}): UvCookieRow => ({ id: `${domain}@/@${name}`, name, value: 'v', domain, path: '/', secure: false, httpOnly: false, set: new Date(now - 1000), ...extra });

beforeEach(async () => {
  const rows = await readUvCookies();
  await writeUvCookies([], rows.map((r) => r.id));
});

describe('cookies.list purges expired cookies (WAVE-B3 §6.1)', () => {
  it('removes them from Scramjet’s jar (persisted) and UV’s rows, and reports only live ones', async () => {
    const f = fakeEngines({
      '.a.example@/@live': sj('live', '.a.example', now + 60_000),
      '.a.example@/@old': sj('old', '.a.example', now - 1),
      '.b.example@/@session': sj('session', '.b.example'),
    });
    await writeUvCookies([uv('fresh', '.a.example'), uv('stale', '.a.example', { expires: new Date(now - 5000) }), uv('aged', '.a.example', { maxAge: 1, set: new Date(now - 5000) })], []);
    const r = await listCookies(f.engines, { site: null });
    expect(r.cookies.map((c) => `${c.engine}:${c.name}`).sort()).toEqual(['scramjet:live', 'scramjet:session', 'ultraviolet:fresh']);
    expect(Object.keys(f.jar()).sort()).toEqual(['.a.example@/@live', '.b.example@/@session']);
    expect(f.persisted()).toBe(1);
    expect((await readUvCookies()).map((x) => x.name)).toEqual(['fresh']);
  });

  it('writes nothing when nothing expired', async () => {
    const f = fakeEngines({ '.a.example@/@live': sj('live', '.a.example') });
    await writeUvCookies([uv('fresh', '.a.example')], []);
    expect(await purgeExpiredCookies(f.engines, now)).toBe(0);
    expect(f.persisted()).toBe(0);
    expect((await readUvCookies()).map((x) => x.name)).toEqual(['fresh']);
  });

  it('judges UV rows as they are when it purges: a cookie the service worker stored again meanwhile is kept', async () => {
    const f = fakeEngines({});
    await writeUvCookies([uv('tok', '.a.example', { expires: new Date(now - 1000) })], []);
    const seen = await readUvCookies(); // what a caller read: expired
    expect(seen.map((x) => x.name)).toEqual(['tok']);
    // The service worker refreshes it (same id) before the purge runs.
    await writeUvCookies([uv('tok', '.a.example', { expires: new Date(now + 60_000) })], []);
    expect(await purgeExpiredCookies(f.engines, now)).toBe(0);
    expect((await readUvCookies()).map((x) => x.name)).toEqual(['tok']);
  });
});

describe('cookies.delete updates live Scramjet documents', () => {
  it('a site: filtered, persisted and re-synced into every live document with clear', async () => {
    const f = fakeEngines({ '.a.example@/@x': sj('x', '.a.example'), '.sub.a.example@/@y': sj('y', '.sub.a.example'), '.b.example@/@z': sj('z', '.b.example') });
    await writeUvCookies([uv('u', '.a.example'), uv('w', '.b.example')], []);
    const r = await deleteCookies(f.engines, { all: false, site: 'a.example', name: null });
    expect(r.deleted).toBe(3);
    expect(Object.keys(f.jar())).toEqual(['.b.example@/@z']);
    expect(f.synced).toHaveLength(1);
    expect(f.synced[0]?.clear).toBe(true);
    expect(JSON.stringify(f.synced[0]?.lines)).toContain('z=v');
    expect((await readUvCookies()).map((x) => x.name)).toEqual(['w']);
  });
});
