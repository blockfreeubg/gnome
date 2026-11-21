/**
 * The `cookies` capability (ENGINE-PROTOCOL §6.11): cookies.list reads both engines' jars (metadata only) and
 * cookies.delete edits both: Scramjet's jar is filtered, persisted and re-synced into every live Scramjet document
 * (the controller's cookie sync with `clear`), UV's `__op` rows are deleted.
 */
import { LIMITS } from '../shared/engine-protocol';
import type { CommandPayload, CommandResult, CookieInfo } from '../shared/engine-protocol';
import { cookieMatcher, deleteExpiredUvCookies, expiredMatcher, partitionJar, readUvCookies, scramjetCookieInfos, setCookieLine, uvCookieInfos, writeUvCookies } from './cookies';
import type { ScramjetCookie, UvCookieRow } from './cookies';
import type { EngineManager } from './engines/manager';

/**
 * Removes expired cookies from both jars (WAVE-B3 §6.1): Scramjet's jar is replaced and persisted without them
 * (read and replaced in one synchronous step; live documents keep their copies, whose reads already skip expired
 * cookies); UV's expired `__op` rows are deleted inside one read-write transaction, so a cookie the service worker
 * stored again meanwhile is kept. A failure leaves the jars as they were (cookies.list still reports only live
 * cookies).
 */
export async function purgeExpiredCookies(engines: EngineManager, now: number, idb?: IDBFactory): Promise<number> {
  const expired = expiredMatcher(now);
  let purged = 0;
  const sj = engines.scramjet;
  if (sj.controller) {
    const { keep, removed } = partitionJar(sj.jar(), (c: ScramjetCookie) => expired(c));
    if (removed > 0) {
      await sj.setJar(keep);
      purged += removed;
    }
  }
  purged += await deleteExpiredUvCookies(now, idb);
  return purged;
}

export async function listCookies(engines: EngineManager, p: CommandPayload<'cookies.list'>): Promise<CommandResult<'cookies.list'>> {
  const now = Date.now();
  await purgeExpiredCookies(engines, now).catch(() => 0);
  const rows = await readUvCookies().catch(() => [] as UvCookieRow[]);
  const all: CookieInfo[] = [];
  if (engines.scramjet.controller) all.push(...scramjetCookieInfos(engines.scramjet.jar(), p.site, now));
  all.push(...uvCookieInfos(rows, p.site, now)); // expired rows (also by Max-Age) are skipped there
  return { cookies: all.slice(0, LIMITS.maxCookies), truncated: all.length > LIMITS.maxCookies };
}

export async function deleteCookies(engines: EngineManager, p: CommandPayload<'cookies.delete'>): Promise<CommandResult<'cookies.delete'>> {
  const match = cookieMatcher(p);
  let deleted = 0;
  const sj = engines.scramjet;
  if (sj.controller) {
    const { keep, removed } = partitionJar(sj.jar(), match);
    if (removed > 0) {
      await sj.setJar(keep);
      const lines = Object.values(keep)
        .map(setCookieLine)
        .filter((l): l is { url: string; cookie: string } => l !== null);
      await sj.controller.propagateCookieSync?.(lines, { clear: true });
      deleted += removed;
    }
  }
  const rows = await readUvCookies().catch(() => []);
  const gone = rows.filter((r) => match({ domain: r.domain, name: r.name })).map((r) => r.id);
  if (gone.length) {
    await writeUvCookies([], gone);
    deleted += gone.length;
  }
  return { deleted };
}
