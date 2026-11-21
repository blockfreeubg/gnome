/**
 * The engine host's end of the app port (ENGINE-PROTOCOL §3–§5): every message runs through validateCommandMessage()
 * before any handler; every command message with a readable id gets exactly one answer (unknown and invalid ones
 * included: `unknown_type` / `bad_request`); a command whose capability is not offered answers `unsupported`; `init`
 * comes first and only once (`bad_state` otherwise); `test.*` commands exist only when the build was made for the e2e
 * harness. Events leave through the Coalescer (COALESCE_MS) and, in self-checking builds, are validated with the
 * protocol's own validators first, so a value the app would reject is caught here.
 */
import {
  COMMAND_ERROR_CODES,
  LIMITS,
  fitText,
  requiredCapability,
  sanitizeText,
  validateCommandMessage,
  validateCommandResult,
  validateEventPayload,
} from '../shared/engine-protocol';
import type {
  AnyCommandMessage,
  Capability,
  CommandErrorCode,
  CommandPayload,
  CommandResult,
  CommandType,
  EventMap,
  EventType,
} from '../shared/engine-protocol';
import { Coalescer, realClock } from './coalesce';
import type { Clock } from './coalesce';

/** The MessagePort the app transferred (structural, so tests can pass either end of a MessageChannel). */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close?(): void;
}

/** A failure with a protocol error code: handlers throw it (anything else answers `failed`). */
export class CommandFailure extends Error {
  readonly code: CommandErrorCode;
  constructor(code: CommandErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CommandFailure';
    this.code = code;
  }
}

export function failure(code: CommandErrorCode, message?: string): CommandFailure {
  return new CommandFailure(code, message);
}

export type Handler<T extends CommandType> = (p: CommandPayload<T>) => CommandResult<T> | Promise<CommandResult<T>>;
export type Handlers = { readonly [T in CommandType]: Handler<T> };
/** Harness-only commands (`test.*`), present only in builds made with __GNOME_ENGINE_TEST__. */
export type TestHandlers = Readonly<Record<string, (p: unknown) => unknown>>;

export interface ProtocolServerOptions {
  handlers: Handlers;
  /** null in production builds: `test.*` then answers `unknown_type` like any unknown command. */
  testHandlers: TestHandlers | null;
  /** The capabilities InitResult reported (a command needing another answers `unsupported`). */
  capabilities: () => readonly Capability[];
  /** Validate every emitted event and every result before sending (debug and e2e builds). */
  selfCheck: boolean;
  clock?: Clock;
  /** Self-check failures and internal errors (the core logs them; never sent as events by this class). */
  onInternalError?: (message: string) => void;
}

/** Commands answered at any time after init started (they read state; they do not need the engines). */
const ALWAYS: ReadonlySet<CommandType> = new Set<CommandType>(['status', 'ping', 'diagnostics']);

export class ProtocolServer {
  readonly #port: PortLike;
  readonly #opts: ProtocolServerOptions;
  readonly #coalescer: Coalescer;
  #init: Promise<unknown> | null = null;
  #closed = false;
  /** Commands rejected by validation, by capability or by state (diagnostics.protocol.rejectedCommands). */
  rejectedCommands = 0;
  /** Events this host failed to fit (self-check builds): a bug to fix, never sent. */
  selfCheckFailures = 0;

  constructor(port: PortLike, opts: ProtocolServerOptions) {
    this.#port = port;
    this.#opts = opts;
    this.#coalescer = new Coalescer((type, p) => this.#post({ k: 'evt', type, p }), opts.clock ?? realClock);
    port.onmessage = (ev: MessageEvent) => {
      void this.#onMessage(ev.data);
    };
  }

  /** Emits an event (values already fitted by the caller); dropped after close(). */
  emit<T extends EventType>(type: T, p: EventMap[T]): void {
    if (this.#closed) return;
    if (this.#opts.selfCheck) {
      const v = validateEventPayload(type, p);
      if (!v.ok) {
        this.selfCheckFailures++;
        this.#opts.onInternalError?.(`self-check: ${type} rejected: ${v.error}`);
        return;
      }
    }
    this.#coalescer.emit(type, p);
  }

  /** Sends what a tab's coalesced events hold (e.g. before tab.state answers). */
  flushTab(tabId: number): void {
    this.#coalescer.flush(`tab:${tabId}`);
  }

  forgetTab(tabId: number): void {
    this.#coalescer.forget(`tab:${tabId}`);
  }

  forgetDownload(downloadId: string): void {
    this.#coalescer.forget(`download:${downloadId}`);
  }

  get initialized(): boolean {
    return this.#init !== null;
  }

  close(): void {
    this.#closed = true;
    this.#coalescer.drain();
    this.#port.onmessage = null;
  }

  #post(message: unknown): void {
    if (this.#closed && (message as { k?: string }).k === 'evt') return;
    try {
      this.#port.postMessage(message);
    } catch (err) {
      // A value that cannot be cloned is a bug in this host; never let it escape as an exception.
      this.#opts.onInternalError?.(`postMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #answerError(id: number, code: CommandErrorCode, message: string): void {
    const clean = fitText(sanitizeText(message), LIMITS.maxMessageLength);
    this.#post({ k: 'res', id, ok: false, error: { code, message: clean } });
  }

  async #onMessage(data: unknown): Promise<void> {
    if (this.#closed) return;
    const test = this.#testCommand(data);
    if (test) {
      await this.#runTest(test.id, test.type, test.p);
      return;
    }
    const v = validateCommandMessage(data);
    if (!v.ok) {
      this.rejectedCommands++;
      if (v.id !== undefined) this.#answerError(v.id, v.code === 'unknown_type' ? 'unknown_type' : 'bad_request', v.error);
      return;
    }
    await this.#dispatch(v.value);
  }

  #testCommand(data: unknown): { id: number; type: string; p: unknown } | null {
    if (!this.#opts.testHandlers || typeof data !== 'object' || data === null) return null;
    const d = data as Record<string, unknown>;
    if (d.k !== 'cmd' || typeof d.type !== 'string' || !d.type.startsWith('test.')) return null;
    if (typeof d.id !== 'number' || !Number.isSafeInteger(d.id) || d.id < 1) return null;
    return { id: d.id, type: d.type, p: d.p };
  }

  async #runTest(id: number, type: string, p: unknown): Promise<void> {
    const h = this.#opts.testHandlers?.[type];
    if (!h) {
      this.#answerError(id, 'unknown_type', `unknown command ${type.slice(0, 40)}`);
      return;
    }
    try {
      const result = await h(p ?? {});
      this.#post({ k: 'res', id, ok: true, p: result ?? {} });
    } catch (err) {
      this.#answerFailure(id, err);
    }
  }

  async #dispatch(msg: AnyCommandMessage): Promise<void> {
    const { id, type } = msg;
    if (type === 'init') {
      if (this.#init) {
        this.rejectedCommands++;
        this.#answerError(id, 'bad_state', 'init was already sent on this port');
        return;
      }
    } else if (!this.#init) {
      this.rejectedCommands++;
      this.#answerError(id, 'bad_state', `${type} before init`);
      return;
    }
    try {
      if (type === 'init') {
        const p = Promise.resolve().then(() => this.#opts.handlers.init(msg.p));
        this.#init = p.catch(() => undefined);
        this.#answerOk(id, type, await p);
        return;
      }
      if (!ALWAYS.has(type)) await this.#init;
      const cap = requiredCapability(type, msg.p as never);
      if (cap !== null && !this.#opts.capabilities().includes(cap)) {
        this.rejectedCommands++;
        this.#answerError(id, 'unsupported', `${type} needs the ${cap} capability, which this engine host does not offer`);
        return;
      }
      const handler = this.#opts.handlers[type] as Handler<typeof type>;
      this.#answerOk(id, type, await handler(msg.p as never));
    } catch (err) {
      this.#answerFailure(id, err);
    }
  }

  #answerOk(id: number, type: CommandType, result: unknown): void {
    if (this.#opts.selfCheck) {
      const v = validateCommandResult(type, result);
      if (!v.ok) {
        this.selfCheckFailures++;
        this.#opts.onInternalError?.(`self-check: result of ${type} rejected: ${v.error}`);
        this.#answerError(id, 'failed', `internal error: invalid ${type} result`);
        return;
      }
    }
    this.#post({ k: 'res', id, ok: true, p: result });
  }

  #answerFailure(id: number, err: unknown): void {
    if (err instanceof CommandFailure) {
      this.#answerError(id, err.code, err.message);
      return;
    }
    const code = (err as { code?: unknown } | null)?.code;
    const known = typeof code === 'string' && (COMMAND_ERROR_CODES as readonly string[]).includes(code);
    const message = err instanceof Error ? err.message : String(err);
    if (!known) this.#opts.onInternalError?.(`command failed: ${message}`);
    this.#answerError(id, known ? (code as CommandErrorCode) : 'failed', message || 'failed');
  }
}
