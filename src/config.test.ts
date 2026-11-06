import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const tmpDir = join(process.cwd(), ".tmp-test-config");

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSoul(content = "You are a test soul."): string {
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, "SOUL.md");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadConfig", () => {
  it("loads required openai settings and defaults", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      DISCORD_BOT_TOKEN: "tok",
      AGENT_BACKEND: "openai",
      API_BASE_URL: "https://api.example.com/v1",
      API_KEY: "key",
      MODEL: "m",
      SYSTEM_PROMPT_FILE: soul,
      DISCORD_ALLOWED_USERS: "111, 222",
      DISCORD_ALLOWED_ROLES: "r1",
      DISCORD_FREE_RESPONSE_CHANNELS: "c1,c2",
    });

    expect(cfg.discordToken).toBe("tok");
    expect(cfg.allowedUsers).toEqual(["111", "222"]);
    expect(cfg.allowedRoles).toEqual(["r1"]);
    expect(cfg.freeResponseChannels).toEqual(["c1", "c2"]);
    expect(cfg.requireMention).toBe(true);
    expect(cfg.allowAllUsers).toBe(false);
    expect(cfg.systemPrompt).toContain("You are a test soul.");
    expect(cfg.systemPrompt).toContain("Runtime identity");
    expect(cfg.systemPrompt).toMatch(/model `m`/);
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxTokens).toBe(1024);
    expect(cfg.memoryMaxKeys).toBe(1_000);
    expect(cfg.rateLimitMaxKeys).toBe(10_000);
    expect(cfg.discordReplyMaxChunks).toBe(8);
    expect(cfg.callbackMaxTextChars).toBe(15_000);
    expect(cfg.webSearchMaxCallsPerRound).toBe(2);
    expect(cfg.webSearchMaxCallsPerRequest).toBe(4);
    expect(cfg.bridgeHttpHost).toBe("0.0.0.0");
    expect(cfg.bridgeHttpPort).toBe(8788);
    expect(cfg.grokBotTimeoutMs).toBe(120_000);
    expect(cfg.grokBotGatewayUrl).toBeNull();
    expect(cfg.bridgeReplyToken).toBeNull();
  });

  it("fails closed without DISCORD_BOT_TOKEN", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        SYSTEM_PROMPT_FILE: soul,
        API_BASE_URL: "https://x",
        API_KEY: "k",
        MODEL: "m",
      }),
    ).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("requires API settings for openai backend", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "tok",
        SYSTEM_PROMPT_FILE: soul,
        AGENT_BACKEND: "openai",
      }),
    ).toThrow(/API_BASE_URL/);
  });

  function grokBotEnv(soul: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      DISCORD_BOT_TOKEN: "tok",
      SYSTEM_PROMPT_FILE: soul,
      AGENT_BACKEND: "grok-bot",
      GROK_BOT_GATEWAY_URL: "http://127.0.0.1:1340",
      GROK_BOT_TOKEN: "gw-token",
      GROK_BOT_AGENT_ID: "agent-from-env",
      BRIDGE_PUBLIC_URL: "http://bridge.example:8788",
      BRIDGE_REPLY_TOKEN: "reply-token",
      ...overrides,
    };
  }

  it("allows grok-bot backend without OpenAI API settings when gateway vars are set", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      ...grokBotEnv(soul),
      DISCORD_ALLOW_ALL_USERS: "true",
    });
    expect(cfg.agentBackend).toBe("grok-bot");
    expect(cfg.allowAllUsers).toBe(true);
    expect(cfg.allowDms).toBe(false);
    expect(cfg.dmOnly).toBe(false);
    expect(cfg.allowedGuilds).toEqual([]);
    expect(cfg.grokBotGatewayUrl).toBe("http://127.0.0.1:1340");
    expect(cfg.grokBotAgentId).toBe("agent-from-env");
    expect(cfg.bridgePublicUrl).toBe("http://bridge.example:8788");
    expect(cfg.bridgeHttpHost).toBe("0.0.0.0");
    expect(cfg.bridgeHttpPort).toBe(8788);
    expect(cfg.grokBotTimeoutMs).toBe(120_000);
  });

  it("fails closed when grok-bot required vars are missing", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "tok",
        SYSTEM_PROMPT_FILE: soul,
        AGENT_BACKEND: "grok-bot",
      }),
    ).toThrow(/GROK_BOT_GATEWAY_URL/);
    expect(() => loadConfig(grokBotEnv(soul, { GROK_BOT_TOKEN: "" }))).toThrow(/GROK_BOT_TOKEN/);
    expect(() => loadConfig(grokBotEnv(soul, { GROK_BOT_AGENT_ID: "" }))).toThrow(
      /GROK_BOT_AGENT_ID/,
    );
    expect(() => loadConfig(grokBotEnv(soul, { BRIDGE_PUBLIC_URL: "" }))).toThrow(
      /BRIDGE_PUBLIC_URL/,
    );
    expect(() => loadConfig(grokBotEnv(soul, { BRIDGE_REPLY_TOKEN: "" }))).toThrow(
      /BRIDGE_REPLY_TOKEN/,
    );
  });

  it("parses grok-bot timeout and bridge listen settings", () => {
    const soul = writeSoul();
    const cfg = loadConfig(
      grokBotEnv(soul, {
        GROK_BOT_TIMEOUT_MS: "90000",
        BRIDGE_HTTP_HOST: "127.0.0.1",
        BRIDGE_HTTP_PORT: "9090",
      }),
    );
    expect(cfg.grokBotTimeoutMs).toBe(90_000);
    expect(cfg.bridgeHttpHost).toBe("127.0.0.1");
    expect(cfg.bridgeHttpPort).toBe(9090);
  });

  it("requires ALLOW_DMS when DM_ONLY is set", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "tok",
        SYSTEM_PROMPT_FILE: soul,
        ...grokBotEnv(soul),
        DISCORD_DM_ONLY: "true",
        DISCORD_ALLOW_DMS: "false",
      }),
    ).toThrow(/DISCORD_DM_ONLY/);
  });

  it("parses guild allowlist and DM flags", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      DISCORD_BOT_TOKEN: "tok",
      SYSTEM_PROMPT_FILE: soul,
      ...grokBotEnv(soul),
      DISCORD_ALLOW_ALL_USERS: "true",
      DISCORD_ALLOWED_GUILDS: "g1, g2",
      DISCORD_ALLOW_DMS: "true",
      DISCORD_DM_ONLY: "true",
    });
    expect(cfg.allowedGuilds).toEqual(["g1", "g2"]);
    expect(cfg.allowDms).toBe(true);
    expect(cfg.dmOnly).toBe(true);
  });

  it("parses hardening bounds and rejects invalid values", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      ...grokBotEnv(soul),
      MEMORY_MAX_KEYS: "25",
      RATE_LIMIT_MAX_KEYS: "50",
      DISCORD_REPLY_MAX_CHUNKS: "6",
      CALLBACK_MAX_TEXT_CHARS: "12000",
      WEB_SEARCH_MAX_CALLS_PER_ROUND: "1",
      WEB_SEARCH_MAX_CALLS_PER_REQUEST: "3",
    });
    expect(cfg.memoryMaxKeys).toBe(25);
    expect(cfg.rateLimitMaxKeys).toBe(50);
    expect(cfg.discordReplyMaxChunks).toBe(6);
    expect(cfg.callbackMaxTextChars).toBe(12_000);
    expect(cfg.webSearchMaxCallsPerRound).toBe(1);
    expect(cfg.webSearchMaxCallsPerRequest).toBe(3);

    expect(() => loadConfig(grokBotEnv(soul, { DISCORD_REPLY_MAX_CHUNKS: "0" }))).toThrow(
      /DISCORD_REPLY_MAX_CHUNKS/,
    );
  });
});
