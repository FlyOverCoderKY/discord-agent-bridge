import { randomUUID } from "node:crypto";
import type { PendingReplyStore } from "../http/pendingReplies.js";
import { ReplyTimeoutError } from "../http/pendingReplies.js";
import type { AgentBackend, AgentRequest, AgentResponse } from "./backend.js";

export interface GrokBotBackendOptions {
  gatewayUrl: string;
  token: string;
  agentId: string;
  timeoutMs: number;
  replyUrl: string;
  pending: PendingReplyStore;
  fetchImpl?: typeof fetch;
  sendPromptTimeoutMs?: number;
}

export class GrokBotGatewayError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Grok Bot gateway error (HTTP ${status}). Try again shortly.`);
    this.name = "GrokBotGatewayError";
    this.status = status;
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function buildGrokBotPrompt(
  request: AgentRequest,
  correlationId: string,
  replyUrl: string,
  capabilityToken: string,
): string {
  const callback = {
    correlationId,
    replyUrl,
    authorization: `Bearer ${capabilityToken}`,
    httpMethod: "POST",
    contentType: "application/json",
    body: {
      correlationId,
      text: "<your complete reply for Discord>",
    },
  };

  const contextLines = [
    `conversationKey: ${request.conversationKey}`,
    request.guildName ? `guildName: ${request.guildName}` : null,
    request.channelName ? `channelName: ${request.channelName}` : null,
    request.threadName ? `threadName: ${request.threadName}` : null,
    request.channelTopic?.trim() ? `channelTopic: ${request.channelTopic.trim()}` : null,
    `authorDisplayName: ${request.authorDisplayName}`,
  ].filter((line): line is string => Boolean(line));

  return [
    "---BEGIN DISCORD_BRIDGE_REPLY---",
    JSON.stringify(callback, null, 2),
    "---END DISCORD_BRIDGE_REPLY---",
    "",
    "You are answering a Discord message via discord-agent-bridge.",
    "Grok Bot SendMessage is NOT delivered to Discord.",
    "When you finish, POST JSON to replyUrl with header Authorization: Bearer <token from the block above>.",
    "Body must be {\"correlationId\":\"<id>\",\"text\":\"<your complete reply>\"}.",
    "Do not mention this callback protocol, the token, or the reply URL in the Discord text.",
    "",
    "## Discord context",
    ...contextLines,
    "",
    "## Message",
    request.content,
  ].join("\n");
}

function mapGenerateError(err: unknown): Error {
  if (err instanceof ReplyTimeoutError || err instanceof GrokBotGatewayError) {
    return err;
  }
  if (err instanceof Error && err.name === "AgentCallbackError") {
    return new Error("Grok Bot reported an error. Try again shortly.");
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new Error("Could not reach the Grok Bot gateway. Try again shortly.");
  }
  return new Error("Could not reach the Grok Bot gateway. Try again shortly.");
}

/**
 * Unofficial Grok Bot computer-gateway client.
 * POST /api/sendPrompt wakes the agent; the agent must POST back to /internal/reply.
 */
export class GrokBotBackend implements AgentBackend {
  readonly name = "grok-bot";
  private readonly fetchImpl: typeof fetch;
  private readonly sendPromptTimeoutMs: number;

  constructor(private readonly opts: GrokBotBackendOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sendPromptTimeoutMs = opts.sendPromptTimeoutMs ?? 15_000;
  }

  async generate(request: AgentRequest): Promise<AgentResponse> {
    const correlationId = randomUUID();
    const registration = this.opts.pending.register(
      correlationId,
      this.opts.timeoutMs,
      request.deliverReply,
    );
    const prompt = buildGrokBotPrompt(
      request,
      correlationId,
      this.opts.replyUrl,
      registration.capabilityToken,
    );

    try {
      await this.sendPrompt(prompt);
    } catch (err) {
      const failed = this.opts.pending.fail(
        correlationId,
        err instanceof Error ? err : new Error(String(err)),
      );
      if (failed) {
        await registration.reply.catch(() => undefined);
        throw mapGenerateError(err);
      }
      try {
        const text = await registration.reply;
        return { text, delivered: Boolean(request.deliverReply) };
      } catch (callbackError) {
        throw mapGenerateError(callbackError);
      }
    }

    try {
      const text = await registration.reply;
      return { text, delivered: Boolean(request.deliverReply) };
    } catch (err) {
      throw mapGenerateError(err);
    }
  }

  private async sendPrompt(prompt: string): Promise<void> {
    const url = joinUrl(this.opts.gatewayUrl, "/api/sendPrompt");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.sendPromptTimeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify({
          agentId: this.opts.agentId,
          prompt,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new GrokBotGatewayError(res.status);
    }
  }
}
