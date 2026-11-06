import { describe, expect, it, vi } from "vitest";
import { PendingReplyStore } from "../http/pendingReplies.js";
import { startReplyServer } from "../http/replyServer.js";
import {
  buildGrokBotPrompt,
  GrokBotBackend,
  GrokBotGatewayError,
  joinUrl,
} from "./grokBot.js";

const request = {
  conversationKey: "channel:123",
  authorDisplayName: "Nate",
  content: "where are cooking pots?",
  channelName: "general",
  threadName: "loot",
  channelTopic: "team chat",
  guildName: "Example Guild",
};

function backendOpts(overrides: Partial<ConstructorParameters<typeof GrokBotBackend>[0]> = {}) {
  return {
    gatewayUrl: "http://gateway.example:1340",
    token: "gateway-token",
    agentId: "agent-from-env",
    timeoutMs: 5_000,
    replyUrl: "http://bridge.example:8788/internal/reply",
    pending: new PendingReplyStore(),
    ...overrides,
  };
}

function correlationIdFromPrompt(prompt: string): string {
  const match = prompt.match(/"correlationId": "([^"]+)"/);
  if (!match?.[1]) throw new Error("prompt missing correlationId");
  return match[1];
}

function capabilityTokenFromPrompt(prompt: string): string {
  const match = prompt.match(/"authorization": "Bearer ([^"]+)"/);
  if (!match?.[1]) throw new Error("prompt missing capability token");
  return match[1];
}

describe("buildGrokBotPrompt", () => {
  it("includes correlationId, replyUrl, Discord context, and bearer instructions", () => {
    const prompt = buildGrokBotPrompt(
      request,
      "corr-abc",
      "http://bridge.example:8788/internal/reply",
      "reply-token",
    );

    expect(prompt).toContain("corr-abc");
    expect(prompt).toContain("http://bridge.example:8788/internal/reply");
    expect(prompt).toContain("Authorization: Bearer");
    expect(prompt).toContain("conversationKey: channel:123");
    expect(prompt).toContain("channelName: general");
    expect(prompt).toContain("threadName: loot");
    expect(prompt).toContain("channelTopic: team chat");
    expect(prompt).toContain("guildName: Example Guild");
    expect(prompt).toContain("authorDisplayName: Nate");
    expect(prompt).toContain("where are cooking pots?");
    expect(prompt).toContain("---BEGIN DISCORD_BRIDGE_REPLY---");
  });
});

describe("GrokBotBackend", () => {
  it("POSTs sendPrompt with correlationId and replyUrl, then resolves from the callback", async () => {
    const pending = new PendingReplyStore("reusable-config-secret");
    const calls: Array<{ url: string; init: RequestInit }> = [];

    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    };

    const grok = new GrokBotBackend(
      backendOpts({
        pending,
        fetchImpl,
        agentId: "agent-from-env",
      }),
    );

    const generatePromise = grok.generate(request);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const sent = JSON.parse(String(calls[0]!.init.body)) as { agentId: string; prompt: string };
    expect(calls[0]!.url).toBe("http://gateway.example:1340/api/sendPrompt");
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer gateway-token",
    });
    expect(sent.agentId).toBe("agent-from-env");
    expect(sent.prompt).toContain("http://bridge.example:8788/internal/reply");
    expect(sent.prompt).toContain("where are cooking pots?");
    expect(sent.prompt).toContain("conversationKey: channel:123");
    expect(sent.prompt).not.toContain("reusable-config-secret");

    const correlationId = correlationIdFromPrompt(sent.prompt);
    await expect(
      pending.complete(
        correlationId,
        capabilityTokenFromPrompt(sent.prompt),
        "Check houses near traders.",
      ),
    ).resolves.toBe("ok");
    await expect(generatePromise).resolves.toEqual({
      text: "Check houses near traders.",
      delivered: false,
    });
  });

  it("resolves generate() when POST /internal/reply completes the pending request", async () => {
    const pending = new PendingReplyStore();
    const server = await startReplyServer({
      host: "127.0.0.1",
      port: 0,
      pending,
    });

    try {
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        calls.push(body.prompt);
        return new Response("{}", { status: 200 });
      };

      const grok = new GrokBotBackend(backendOpts({ pending, fetchImpl }));
      const generatePromise = grok.generate(request);
      await vi.waitFor(() => expect(calls).toHaveLength(1));

      const correlationId = correlationIdFromPrompt(calls[0]!);
      const capabilityToken = capabilityTokenFromPrompt(calls[0]!);
      const res = await fetch(`http://127.0.0.1:${server.port}/internal/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${capabilityToken}`,
        },
        body: JSON.stringify({ correlationId, text: "Traders sell pots." }),
      });

      expect(res.status).toBe(200);
      await expect(generatePromise).resolves.toEqual({
        text: "Traders sell pots.",
        delivered: false,
      });
    } finally {
      await server.close();
    }
  });

  it("delivers to Discord via the pending callback before generate() resolves", async () => {
    const pending = new PendingReplyStore();
    const delivered: string[] = [];
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const grok = new GrokBotBackend(backendOpts({ pending, fetchImpl }));

    const generatePromise = grok.generate({
      ...request,
      deliverReply: async (text) => {
        delivered.push(text);
      },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(calls[0]!) as { prompt: string };
    await pending.complete(
      correlationIdFromPrompt(body.prompt),
      capabilityTokenFromPrompt(body.prompt),
      "Posted first.",
    );
    await expect(generatePromise).resolves.toEqual({ text: "Posted first.", delivered: true });
    expect(delivered).toEqual(["Posted first."]);
  });

  it("lets an authenticated delivery finish when the gateway request fails late", async () => {
    const pending = new PendingReplyStore();
    let prompt = "";
    let rejectGateway: ((error: Error) => void) | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      prompt = body.prompt;
      return new Promise<Response>((_resolve, reject) => {
        rejectGateway = reject;
      });
    };
    let finishDelivery: (() => void) | undefined;
    const grok = new GrokBotBackend(backendOpts({ pending, fetchImpl }));
    const generatePromise = grok.generate({
      ...request,
      deliverReply: async () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    });
    await vi.waitFor(() => expect(prompt).not.toBe(""));

    const completePromise = pending.complete(
      correlationIdFromPrompt(prompt),
      capabilityTokenFromPrompt(prompt),
      "delivered",
    );
    await vi.waitFor(() => expect(finishDelivery).toBeDefined());
    rejectGateway?.(new Error("late gateway failure"));
    finishDelivery?.();

    await expect(completePromise).resolves.toBe("ok");
    await expect(generatePromise).resolves.toEqual({ text: "delivered", delivered: true });
  });

  it("times out when the agent never callbacks", async () => {
    const fetchImpl: typeof fetch = async () => new Response("{}", { status: 200 });
    const grok = new GrokBotBackend(backendOpts({ fetchImpl, timeoutMs: 40 }));

    await expect(grok.generate(request)).rejects.toThrow(/timed out waiting for a reply/i);
  });

  it("maps gateway HTTP errors to a short Discord-friendly string", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 502 });
    const grok = new GrokBotBackend(backendOpts({ fetchImpl }));

    await expect(grok.generate(request)).rejects.toBeInstanceOf(GrokBotGatewayError);
    await expect(grok.generate(request)).rejects.toThrow(/HTTP 502/);
  });
});

describe("joinUrl", () => {
  it("joins gateway and public URL bases without double slashes", () => {
    expect(joinUrl("http://host:1340/", "/api/sendPrompt")).toBe("http://host:1340/api/sendPrompt");
    expect(joinUrl("http://bridge:8788", "internal/reply")).toBe("http://bridge:8788/internal/reply");
  });
});
