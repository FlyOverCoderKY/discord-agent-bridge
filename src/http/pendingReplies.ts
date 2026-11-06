import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class ReplyTimeoutError extends Error {
  readonly correlationId: string;

  constructor(correlationId: string) {
    super("Grok Bot timed out waiting for a reply. Try again shortly.");
    this.name = "ReplyTimeoutError";
    this.correlationId = correlationId;
  }
}

export class AgentCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCallbackError";
  }
}

export type CompleteResult = "missing" | "unauthorized" | "ok" | "delivery_failed";
const MAX_DELIVERY_ATTEMPTS = 2;

export interface PendingReplyRegistration {
  capabilityToken: string;
  reply: Promise<string>;
}

interface PendingEntry {
  capabilityDigest: Buffer;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deadlineMs: number;
  deliver?: (text: string) => Promise<void>;
  delivering: boolean;
  deliveryAttempts: number;
}

/**
 * In-process waiters for Grok Bot agent callbacks keyed by correlationId.
 * Entries stay registered until Discord delivery succeeds (or the waiter times out / is failed).
 */
export class PendingReplyStore {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly missingCapabilityDigest = randomBytes(32);

  constructor(private readonly capabilityKey: string = randomBytes(32).toString("base64url")) {}

  register(
    correlationId: string,
    timeoutMs: number,
    deliver?: (text: string) => Promise<void>,
  ): PendingReplyRegistration {
    if (this.pending.has(correlationId)) {
      throw new Error("Duplicate correlationId");
    }

    const capabilityToken = randomBytes(32).toString("base64url");
    const reply = new Promise<string>((resolve, reject) => {
      const entry = {
        capabilityDigest: this.digestCapability(capabilityToken),
        resolve,
        reject,
        deadlineMs: Date.now() + timeoutMs,
        deliver,
        delivering: false,
        deliveryAttempts: 0,
      } as PendingEntry;
      this.pending.set(correlationId, entry);
      this.armTimeout(correlationId, entry);
    });
    void reply.catch(() => undefined);
    return { capabilityToken, reply };
  }

  async complete(
    correlationId: string,
    capabilityToken: string,
    text: string,
  ): Promise<CompleteResult> {
    const entry = this.pending.get(correlationId);
    const authResult = this.authorize(entry, capabilityToken);
    if (authResult !== "ok") return authResult;
    if (!entry) return "missing";
    if (entry.delivering) return "delivery_failed";
    if (entry.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) return "delivery_failed";

    entry.delivering = true;
    entry.deliveryAttempts += 1;

    try {
      if (entry.deliver) {
        await this.deliverBeforeDeadline(entry, text);
      }
      if (Date.now() >= entry.deadlineMs) {
        this.expire(correlationId, entry);
        return "missing";
      }
      if (this.pending.get(correlationId) !== entry) {
        return "missing";
      }
      clearTimeout(entry.timer);
      this.pending.delete(correlationId);
      entry.resolve(text);
      return "ok";
    } catch {
      entry.delivering = false;
      if (!this.pending.has(correlationId)) {
        return "missing";
      }
      return "delivery_failed";
    }
  }

  verifyCapability(
    correlationId: string,
    capabilityToken: string,
  ): "missing" | "unauthorized" | "ok" {
    return this.authorize(this.pending.get(correlationId), capabilityToken);
  }

  failCallback(correlationId: string, capabilityToken: string, error: Error): CompleteResult {
    const entry = this.pending.get(correlationId);
    const authResult = this.authorize(entry, capabilityToken);
    if (authResult !== "ok") return authResult;
    if (entry?.delivering) return "delivery_failed";
    this.fail(correlationId, error);
    return "ok";
  }

  fail(correlationId: string, error: Error): boolean {
    const entry = this.pending.get(correlationId);
    if (!entry) return false;
    if (entry.delivering) return false;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    entry.reject(error);
    return true;
  }

  has(correlationId: string): boolean {
    return this.pending.has(correlationId);
  }

  get size(): number {
    return this.pending.size;
  }

  private armTimeout(correlationId: string, entry: PendingEntry): void {
    const remaining = entry.deadlineMs - Date.now();
    if (remaining <= 0) {
      this.expire(correlationId, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      this.expire(correlationId, entry);
    }, remaining);
  }

  private async deliverBeforeDeadline(entry: PendingEntry, text: string): Promise<void> {
    const remaining = entry.deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("delivery_deadline_exceeded");

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => entry.deliver!(text)),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error("delivery_deadline_exceeded")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  private expire(correlationId: string, entry: PendingEntry): void {
    if (this.pending.get(correlationId) !== entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    entry.reject(new ReplyTimeoutError(correlationId));
  }

  private digestCapability(capabilityToken: string): Buffer {
    return createHmac("sha256", this.capabilityKey).update(capabilityToken).digest();
  }

  private authorize(
    entry: PendingEntry | undefined,
    capabilityToken: string,
  ): "missing" | "unauthorized" | "ok" {
    const providedDigest = this.digestCapability(capabilityToken);
    const matches = timingSafeEqual(
      providedDigest,
      entry?.capabilityDigest ?? this.missingCapabilityDigest,
    );
    if (!entry) return "missing";
    return matches ? "ok" : "unauthorized";
  }
}
