/**
 * The two engines together (ENGINE-PROTOCOL §6.2): initialization in parallel, which engine a navigation uses
 * (forced by the command, by the settings, or Scramjet first with the controlled fallback), and decoding any proxied
 * URL of this origin back to the real one.
 */
import type { EngineId, EngineSettings, EngineStatus } from '../../shared/engine-protocol';
import { PROXY_PATHS } from '../../shared/proxy-origin';
import type { SwClient } from '../../shared/proxy-origin';
import type { TransportManager } from '../../shared/transport';
import { VERSIONS } from '../build-info';
import { ScramjetEngine } from './scramjet';
import type { ScramjetFrameLike } from './vendor';
import { UltravioletEngine } from './ultraviolet';

export interface EngineChoice {
  engine: EngineId;
  /** The engine was chosen by the command or by the settings: no automatic fallback. */
  forced: boolean;
  /** Scramjet would have been used but failed to initialize (one tab.engineSwitched{init-failed} per tab). */
  initFailed: boolean;
}

export class NoEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoEngineError';
  }
}

export class EngineManager {
  readonly scramjet: ScramjetEngine;
  readonly ultraviolet: UltravioletEngine;

  constructor(enabled: Readonly<Record<EngineId, boolean>>) {
    this.scramjet = new ScramjetEngine(VERSIONS.scramjet, enabled.scramjet);
    this.ultraviolet = new UltravioletEngine(VERSIONS.ultraviolet, enabled.ultraviolet);
  }

  async init(transport: TransportManager, sw: SwClient): Promise<void> {
    await Promise.all([this.scramjet.init(transport, sw), this.ultraviolet.init(transport)]);
  }

  ready(e: EngineId): boolean {
    return e === 'scramjet' ? this.scramjet.ready : this.ultraviolet.ready;
  }

  statuses(): Record<EngineId, EngineStatus> {
    return { scramjet: { ...this.scramjet.status }, ultraviolet: { ...this.ultraviolet.status } };
  }

  /**
   * The engine for a navigation: the command's engine (must be ready), else the settings' forced engine, else
   * Scramjet with the controlled fallback. A forced engine that is not ready gives way to the other one only for
   * the settings' choice (the command's choice fails with engine_unavailable).
   */
  choose(commandEngine: EngineId | null, settings: Pick<EngineSettings, 'engine'>): EngineChoice {
    if (commandEngine) {
      if (!this.ready(commandEngine)) throw new NoEngineError(`${commandEngine} is not available (${this.statusText(commandEngine)})`);
      return { engine: commandEngine, forced: true, initFailed: false };
    }
    if (settings.engine !== 'auto') {
      if (this.ready(settings.engine)) return { engine: settings.engine, forced: true, initFailed: false };
      const other: EngineId = settings.engine === 'scramjet' ? 'ultraviolet' : 'scramjet';
      if (this.ready(other)) return { engine: other, forced: true, initFailed: false };
      throw new NoEngineError('no proxy engine is ready');
    }
    if (this.scramjet.ready) return { engine: 'scramjet', forced: false, initFailed: false };
    if (this.ultraviolet.ready) return { engine: 'ultraviolet', forced: false, initFailed: this.scramjet.status.state === 'failed' };
    throw new NoEngineError('no proxy engine is ready');
  }

  #statusText(e: EngineId): string {
    const s = e === 'scramjet' ? this.scramjet.status : this.ultraviolet.status;
    return s.detail ? `${s.state}: ${s.detail}` : s.state;
  }

  statusText(e: EngineId): string {
    return this.#statusText(e);
  }

  /** Which engine serves a URL of this origin, by its prefix (null for anything else). */
  engineOf(raw: URL): EngineId | null {
    if (raw.origin !== location.origin) return null;
    if (raw.pathname.startsWith(PROXY_PATHS.scramjetPrefix)) return 'scramjet';
    const uv = this.ultraviolet.prefix ?? PROXY_PATHS.ultravioletPrefix;
    if (raw.pathname.startsWith(uv)) return 'ultraviolet';
    return null;
  }

  /**
   * The real URL behind a URL a proxied document or an engine produced: a URL under an engine prefix is decoded;
   * another URL of the proxy origin is not a page URL (null); a URL of another origin is returned as is (an escaped
   * frame, or an unproxied value).
   */
  decode(raw: string, base: string, frame: ScramjetFrameLike | null = null): string | null {
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      return null;
    }
    if (u.origin !== location.origin) return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    const e = this.engineOf(u);
    if (e === 'scramjet') return this.scramjet.decode(u, frame);
    if (e === 'ultraviolet') return this.ultraviolet.decode(u);
    return null;
  }
}
