import { Notification } from "@maestro/contracts";
import type { SecretPort, WorkPort } from "@maestro/ports";
import type { FetchInit, FetchLike, SocketLike, TlsInfo } from "../src/deps.js";

/** Offline test doubles. Nothing here touches a network, a clock or a disk. */

export function aNotification(overrides: Partial<Notification> = {}): Notification {
  return Notification.parse({
    event: "gate_open",
    channel: "teams",
    to: ["ops"],
    locale: "tr",
    messageKey: "notify.gate_open",
    params: { ticket: "UGURPAY-501", gate: "5", owner: "Ayşe" },
    at: "2026-08-08T09:00:00+03:00",
    ...overrides,
  });
}

export interface RecordedCall {
  url: string;
  init: FetchInit;
}

export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private readonly queue: (() => Response | Promise<never>)[] = [];

  readonly fetch: FetchLike = async (url, init) => {
    this.calls.push({ url, init });
    const next = this.queue.shift();
    if (!next) throw new Error(`unexpected fetch call to ${url}`);
    return next();
  };

  reply(status: number, body = "", headers: Record<string, string> = {}): this {
    this.queue.push(() => new Response(body, { status, headers }));
    return this;
  }

  fail(message: string): this {
    this.queue.push(() => Promise.reject(new Error(message)));
    return this;
  }

  get bodies(): unknown[] {
    return this.calls.map((call) => JSON.parse(call.init.body ?? "null"));
  }
}

export function fakeSecrets(values: Record<string, string>): SecretPort {
  return {
    async get(key) {
      const value = values[key];
      if (value === undefined) throw new Error(`no such secret: ${key}`);
      return value;
    },
    async issueShortLived() {
      throw new Error("not used by notify");
    },
    async set() {
      throw new Error("not used by notify");
    },
  };
}

/** Records every sleep instead of waiting: retry tests stay instant. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

export interface FakeWork extends WorkPort {
  readonly comments: { ticket: string; body: unknown }[];
}

/** WorkPort double: only `addComment` is exercised by the notify driver. */
export function fakeWorkPort(behaviour?: (ticket: string, call: number) => void): FakeWork {
  const comments: { ticket: string; body: unknown }[] = [];
  let call = 0;
  const unsupported = (): never => {
    throw new Error("not used by notify");
  };
  return {
    comments,
    async addComment(ticket, body) {
      call += 1;
      behaviour?.(ticket, call);
      comments.push({ ticket, body });
      return { commentId: `c${call}` };
    },
    verifyWebhook: unsupported,
    getTicket: unsupported,
    updateComment: unsupported,
    setLabels: unsupported,
    assign: unsupported,
    createLinkedIssue: unsupported,
    parseCommand: unsupported,
    verifyMembership: unsupported,
    transition: unsupported,
  } as FakeWork;
}

/** A correctly verified TLS session against the relay the config names. */
export const GOOD_TLS: TlsInfo = {
  authorized: true,
  protocol: "TLSv1.3",
  servername: "mail.bank.local",
};

export interface FakeSocketOptions {
  /** What `startTls()`/`tlsInfo()` report; defaults to a verified session. */
  tls?: TlsInfo;
  /** Already encrypted before the first byte (implicit TLS). */
  secureFromStart?: boolean;
  /** Thrown by `close()` — the "connection reset on QUIT" case. */
  closeError?: Error;
}

/**
 * Scripted SMTP server: every `read()` hands back the next canned reply, and
 * every command the client writes is recorded for assertions.
 */
export class FakeSocket implements SocketLike {
  readonly written: string[] = [];
  tlsUpgrades = 0;
  closed = 0;
  private readonly encoder = new TextEncoder();
  private secure: boolean;

  constructor(
    private readonly replies: string[],
    private readonly options: FakeSocketOptions = {},
  ) {
    this.secure = options.secureFromStart ?? false;
  }

  async read(): Promise<Uint8Array | null> {
    const next = this.replies.shift();
    return next === undefined ? null : this.encoder.encode(next);
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(data));
  }

  async startTls(): Promise<TlsInfo> {
    this.tlsUpgrades += 1;
    this.secure = true;
    return this.options.tls ?? GOOD_TLS;
  }

  async tlsInfo(): Promise<TlsInfo | null> {
    return this.secure ? (this.options.tls ?? GOOD_TLS) : null;
  }

  async close(): Promise<void> {
    this.closed += 1;
    if (this.options.closeError) throw this.options.closeError;
  }

  /** The command verbs the client sent, without arguments. */
  get verbs(): string[] {
    return this.written.map((line) => line.trim().split(/\s+/)[0] ?? "");
  }
}

/**
 * A relay that offers STARTTLS + AUTH and accepts everything. Reply order:
 * 0 greeting · 1 EHLO · 2 STARTTLS · 3 EHLO · 4 AUTH · 5 MAIL ·
 * 6..(5+n) RCPT · 6+n DATA · 7+n body · 8+n QUIT.
 */
export function happyRelayReplies(recipients = 2): string[] {
  return [
    "220 mail.bank.local ESMTP\r\n",
    "250-mail.bank.local\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n",
    "220 ready to start TLS\r\n",
    "250-mail.bank.local\r\n250 AUTH PLAIN LOGIN\r\n",
    "235 authenticated\r\n",
    "250 sender ok\r\n",
    ...Array.from({ length: recipients }, () => "250 recipient ok\r\n"),
    "354 end with .\r\n",
    "250 queued as 1A2B3C\r\n",
    "221 bye\r\n",
  ];
}
