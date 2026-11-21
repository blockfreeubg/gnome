/**
 * A TransportManager for lane a's tests (WAVE-B §2 "Fakes"): every call is recorded, the status and the ticket
 * requests are scripted by the test. No network, no engines.
 */
import type { EngineId, NeedTicketReason, Ticket, TransportStatus } from '../../shared/engine-protocol';
import type { ProxyFetchInit, ProxyFetchResult, ScramjetTransport, ScramjetTransportSink, TransportDiagnostics, TransportManager, TransportOptions } from '../../shared/transport';

export class FakeTransportManager implements TransportManager {
  readonly calls: Array<{ fn: string; args: unknown[] }> = [];
  #status: Record<EngineId, TransportStatus> = {
    scramjet: { state: 'connecting', transport: 'libcurl', endpoint: 'default', detail: null, since: 0, retryInMs: null },
    ultraviolet: { state: 'connecting', transport: 'libcurl', endpoint: 'default', detail: null, since: 0, retryInMs: null },
  };
  readonly #statusListeners = new Set<(s: Record<EngineId, TransportStatus>) => void>();
  readonly #ticketListeners = new Set<(r: NeedTicketReason) => void>();
  sink: ScramjetTransportSink | null = null;
  scramjetFails = false;
  ultravioletFails = false;
  fetchResult: ProxyFetchResult = { status: 200, headers: [], body: new ArrayBuffer(0) };

  async start(opts: TransportOptions): Promise<void> {
    this.calls.push({ fn: 'start', args: [opts] });
    for (const side of ['scramjet', 'ultraviolet'] as const) {
      this.#status[side] = { ...this.#status[side], transport: opts.transport, state: opts.ticket ? 'ready' : 'offline', detail: opts.ticket ? null : 'ticket-missing' };
    }
    if (!opts.ticket) this.needTicket('missing');
    this.#emitStatus();
  }

  async scramjetTransport(): Promise<ScramjetTransport> {
    this.calls.push({ fn: 'scramjetTransport', args: [] });
    if (this.scramjetFails) throw new Error('scramjet transport failed (fake)');
    return { fake: 'scramjet-transport' };
  }

  bindScramjet(sink: ScramjetTransportSink): void {
    this.calls.push({ fn: 'bindScramjet', args: [] });
    this.sink = sink;
  }

  async ultravioletReady(): Promise<void> {
    this.calls.push({ fn: 'ultravioletReady', args: [] });
    if (this.ultravioletFails) throw new Error('ultraviolet transport failed (fake)');
  }

  async configure(opts: Pick<TransportOptions, 'route' | 'transport'>): Promise<void> {
    this.calls.push({ fn: 'configure', args: [opts] });
  }

  async setTicket(ticket: Ticket): Promise<void> {
    this.calls.push({ fn: 'setTicket', args: [ticket] });
  }

  status(): Record<EngineId, TransportStatus> {
    return { scramjet: { ...this.#status.scramjet }, ultraviolet: { ...this.#status.ultraviolet } };
  }

  onStatus(listener: (status: Record<EngineId, TransportStatus>) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onNeedTicket(listener: (reason: NeedTicketReason) => void): () => void {
    this.#ticketListeners.add(listener);
    return () => this.#ticketListeners.delete(listener);
  }

  reportFailure(side: EngineId, detail: string): void {
    this.calls.push({ fn: 'reportFailure', args: [side, detail] });
  }

  useHooks(): void {
    this.calls.push({ fn: 'useHooks', args: [] });
  }

  async proxyFetch(url: string, init: ProxyFetchInit): Promise<ProxyFetchResult> {
    this.calls.push({ fn: 'proxyFetch', args: [url, init] });
    return this.fetchResult;
  }

  diagnostics(): TransportDiagnostics {
    return {
      probes: { valid: 0, rejected: 0, unreachable: 0, rateLimited: 0, upstreamDown: 0, unknownProfile: 0 },
      rebuilds: { scramjet: 0, ultraviolet: 0 },
      drops: { scramjet: 0, ultraviolet: 0 },
    };
  }

  /** Test: change a side's status (notifies listeners). */
  setStatus(side: EngineId, patch: Partial<TransportStatus>): void {
    this.#status[side] = { ...this.#status[side], ...patch };
    this.#emitStatus();
  }

  /** Test: the manager asks for a ticket. */
  needTicket(reason: NeedTicketReason): void {
    for (const l of this.#ticketListeners) l(reason);
  }

  #emitStatus(): void {
    for (const l of this.#statusListeners) l(this.status());
  }
}
