import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "node:net";
import { PendingReplyStore, ReplyTimeoutError } from "./pendingReplies.js";
import { startReplyServer, type StartedReplyServer } from "./replyServer.js";

const TOKEN = "test-reply-token";

async function listen(
  pending: PendingReplyStore,
  maxTextChars?: number,
): Promise<StartedReplyServer> {
  return startReplyServer({
    host: "127.0.0.1",
    port: 0,
    pending,
    maxTextChars,
  });
}

async function postReply(
  server: StartedReplyServer,
  opts: {
    token?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  }
  const res = await fetch(`http://127.0.0.1:${server.port}/internal/reply`, {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /internal/reply", () => {
  const servers: StartedReplyServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  it("returns 401 when the bearer token is missing", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const res = await postReply(server, { token: null, body: { correlationId: "c", text: "hi" } });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
  });

  it("returns 401 when the bearer token is wrong", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);
    const registration = pending.register("c", 5_000);

    const res = await postReply(server, {
      token: "wrong-token",
      body: { correlationId: "c", text: "hi" },
    });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
    pending.fail("c", new Error("test cleanup"));
    await expect(registration.reply).rejects.toThrow("test cleanup");
  });

  it("returns 400 when required fields are missing", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const missingId = await postReply(server, { body: { text: "hi" } });
    expect(missingId.status).toBe(400);

    const missingText = await postReply(server, { body: { correlationId: "c1" } });
    expect(missingText.status).toBe(400);

    const empty = await postReply(server, { body: { correlationId: "  ", text: "  " } });
    expect(empty.status).toBe(400);
  });

  it("returns 404 for an unknown correlationId", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const res = await postReply(server, {
      body: { correlationId: "missing", text: "hello" },
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("unknown_correlation_id");
  });

  it("returns 404 for an expired correlationId", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const registration = pending.register("expired", 20);
    await expect(registration.reply).rejects.toBeInstanceOf(ReplyTimeoutError);

    const res = await postReply(server, {
      token: registration.capabilityToken,
      body: { correlationId: "expired", text: "too late" },
    });
    expect(res.status).toBe(404);
  });

  it("resolves a pending generate waiter on a valid reply", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const registration = pending.register("corr-1", 5_000);
    const res = await postReply(server, {
      token: registration.capabilityToken,
      body: { correlationId: "corr-1", text: "Pots are in houses and trader inventories." },
    });

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    await expect(registration.reply).resolves.toBe("Pots are in houses and trader inventories.");
    expect(pending.has("corr-1")).toBe(false);
  });

  it("keeps the pending entry when Discord delivery fails so a later retry can complete", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    let attempts = 0;
    const registration = pending.register("corr-retry", 5_000, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("discord 502");
    });

    const first = await postReply(server, {
      token: registration.capabilityToken,
      body: { correlationId: "corr-retry", text: "hello from Discord" },
    });
    expect(first.status).toBe(503);
    expect(first.json.error).toBe("delivery_failed");
    expect(pending.has("corr-retry")).toBe(true);

    let settled = false;
    void registration.reply.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    const second = await postReply(server, {
      token: registration.capabilityToken,
      body: { correlationId: "corr-retry", text: "hello from Discord" },
    });
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    await expect(registration.reply).resolves.toBe("hello from Discord");
    expect(attempts).toBe(2);
    expect(pending.has("corr-retry")).toBe(false);
  });

  it("rejects oversized callback text without consuming the capability", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending, 12);
    servers.push(server);
    const registration = pending.register("bounded", 5_000);

    const oversized = await postReply(server, {
      token: registration.capabilityToken,
      body: { correlationId: "bounded", text: "x".repeat(13) },
    });
    expect(oversized.status).toBe(413);
    expect(oversized.json.error).toBe("reply_too_large");

    const valid = await postReply(server, {
      token: registration.capabilityToken,
      body: { correlationId: "bounded", text: "fits" },
    });
    expect(valid.status).toBe(200);
    await expect(registration.reply).resolves.toBe("fits");
  });

  it("returns 413 as soon as the request body exceeds the byte limit", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: server.port });
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out waiting for early 413"));
      }, 2_000);
      socket.on("connect", () => {
        const body = "x".repeat(1_000_001);
        socket.write(
          `POST /internal/reply HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer test\r\nContent-Length: ${body.length + 1}\r\nConnection: close\r\n\r\n`,
        );
        socket.write(body);
      });
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        if (received.includes(" 413 ")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(received);
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(response).toContain("HTTP/1.1 413");
    expect(response).toContain("payload_too_large");
  });
});
