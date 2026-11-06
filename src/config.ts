import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AgentBackendKind = "openai" | "grok-bot";

export interface Config {
  discordToken: string;
  allowedRoles: string[];
  allowAllUsers: boolean;
  allowedUsers: string[];
  allowedGuilds: string[];
  allowDms: boolean;
  dmOnly: boolean;
  freeResponseChannels: string[];
  requireMention: boolean;
  homeChannel: string | null;
  agentBackend: AgentBackendKind;
  apiBaseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  systemPrompt: string;
  systemPromptFile: string;
  temperature: number;
  maxTokens: number;
  memoryMaxMessages: number;
  memoryMaxKeys: number;
  rateLimitPerUser: number;
  rateLimitWindowMs: number;
  rateLimitMaxKeys: number;
  discordReplyMaxChunks: number;
  callbackMaxTextChars: number;
  webSearchMaxCallsPerRound: number;
  webSearchMaxCallsPerRequest: number;
  braveApiKey: string | null;
  tavilyApiKey: string | null;
  grokBotGatewayUrl: string | null;
  grokBotToken: string | null;
  grokBotAgentId: string | null;
  grokBotTimeoutMs: number;
  bridgeHttpHost: string;
  bridgeHttpPort: number;
  bridgePublicUrl: string | null;
  bridgeReplyToken: string | null;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean env value: ${value}`);
}

function parseCsvIds(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env value: ${value}`);
  return n;
}

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = parseNumber(value, defaultValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function loadSystemPrompt(filePath: string): string {
  const absolute = resolve(process.cwd(), filePath);
  try {
    return readFileSync(absolute, "utf8").trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read SYSTEM_PROMPT_FILE (${filePath}): ${message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const discordToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!discordToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const agentBackendRaw = (env.AGENT_BACKEND?.trim() || "openai").toLowerCase();
  if (agentBackendRaw !== "openai" && agentBackendRaw !== "grok-bot") {
    throw new Error(`AGENT_BACKEND must be "openai" or "grok-bot", got: ${agentBackendRaw}`);
  }
  const agentBackend = agentBackendRaw as AgentBackendKind;

  const systemPromptFile = env.SYSTEM_PROMPT_FILE?.trim() || "SOUL.md";
  let systemPrompt = loadSystemPrompt(systemPromptFile);

  const apiBaseUrl = env.API_BASE_URL?.trim() || null;
  const apiKey = env.API_KEY?.trim() || null;
  const model = env.MODEL?.trim() || null;

  // Keep identity truthful: many models default to "I'm ChatGPT" when asked.
  if (model) {
    systemPrompt = `${systemPrompt}

## Runtime identity
- You are served through an OpenAI-compatible API as model \`${model}\`.
- When asked which model/product you are, answer with that model id (e.g. Grok via OpenRouter if the id is under \`x-ai/\`).
- Do not claim to be ChatGPT, OpenAI, Claude, or any other vendor unless the model id actually is that product.`;
  }

  const grokBotGatewayUrl = env.GROK_BOT_GATEWAY_URL?.trim() || null;
  const grokBotToken = env.GROK_BOT_TOKEN?.trim() || null;
  const grokBotAgentId = env.GROK_BOT_AGENT_ID?.trim() || null;
  const grokBotTimeoutMs = parseNumber(env.GROK_BOT_TIMEOUT_MS, 120_000);
  const bridgeHttpHost = env.BRIDGE_HTTP_HOST?.trim() || "0.0.0.0";
  const bridgeHttpPort = parseNumber(env.BRIDGE_HTTP_PORT, 8788);
  const bridgePublicUrl = env.BRIDGE_PUBLIC_URL?.trim() || null;
  const bridgeReplyToken = env.BRIDGE_REPLY_TOKEN?.trim() || null;

  if (agentBackend === "openai") {
    if (!apiBaseUrl) throw new Error("API_BASE_URL is required when AGENT_BACKEND=openai");
    if (!apiKey) throw new Error("API_KEY is required when AGENT_BACKEND=openai");
    if (!model) throw new Error("MODEL is required when AGENT_BACKEND=openai");
  }

  if (agentBackend === "grok-bot") {
    if (!grokBotGatewayUrl) {
      throw new Error("GROK_BOT_GATEWAY_URL is required when AGENT_BACKEND=grok-bot");
    }
    if (!grokBotToken) {
      throw new Error("GROK_BOT_TOKEN is required when AGENT_BACKEND=grok-bot");
    }
    if (!grokBotAgentId) {
      throw new Error("GROK_BOT_AGENT_ID is required when AGENT_BACKEND=grok-bot");
    }
    if (!bridgePublicUrl) {
      throw new Error("BRIDGE_PUBLIC_URL is required when AGENT_BACKEND=grok-bot");
    }
    if (!bridgeReplyToken) {
      throw new Error("BRIDGE_REPLY_TOKEN is required when AGENT_BACKEND=grok-bot");
    }
    if (grokBotTimeoutMs <= 0) {
      throw new Error("GROK_BOT_TIMEOUT_MS must be a positive number");
    }
    if (!Number.isInteger(bridgeHttpPort) || bridgeHttpPort < 1 || bridgeHttpPort > 65535) {
      throw new Error("BRIDGE_HTTP_PORT must be an integer between 1 and 65535");
    }
  }

  const allowDms = parseBool(env.DISCORD_ALLOW_DMS, false);
  const dmOnly = parseBool(env.DISCORD_DM_ONLY, false);
  if (dmOnly && !allowDms) {
    throw new Error("DISCORD_DM_ONLY=true requires DISCORD_ALLOW_DMS=true");
  }

  return {
    discordToken,
    allowedRoles: parseCsvIds(env.DISCORD_ALLOWED_ROLES),
    allowAllUsers: parseBool(env.DISCORD_ALLOW_ALL_USERS, false),
    allowedUsers: parseCsvIds(env.DISCORD_ALLOWED_USERS),
    allowedGuilds: parseCsvIds(env.DISCORD_ALLOWED_GUILDS),
    allowDms,
    dmOnly,
    freeResponseChannels: parseCsvIds(env.DISCORD_FREE_RESPONSE_CHANNELS),
    requireMention: parseBool(env.DISCORD_REQUIRE_MENTION, true),
    homeChannel: env.DISCORD_HOME_CHANNEL?.trim() || null,
    agentBackend,
    apiBaseUrl,
    apiKey,
    model,
    systemPrompt,
    systemPromptFile,
    temperature: parseNumber(env.TEMPERATURE, 0.7),
    maxTokens: parseNumber(env.MAX_TOKENS, 1024),
    memoryMaxMessages: parseNumber(env.MEMORY_MAX_MESSAGES, 20),
    memoryMaxKeys: parsePositiveInteger(env.MEMORY_MAX_KEYS, 1_000, "MEMORY_MAX_KEYS"),
    rateLimitPerUser: parseNumber(env.RATE_LIMIT_PER_USER, 5),
    rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxKeys: parsePositiveInteger(
      env.RATE_LIMIT_MAX_KEYS,
      10_000,
      "RATE_LIMIT_MAX_KEYS",
    ),
    discordReplyMaxChunks: parsePositiveInteger(
      env.DISCORD_REPLY_MAX_CHUNKS,
      8,
      "DISCORD_REPLY_MAX_CHUNKS",
    ),
    callbackMaxTextChars: parsePositiveInteger(
      env.CALLBACK_MAX_TEXT_CHARS,
      15_000,
      "CALLBACK_MAX_TEXT_CHARS",
    ),
    webSearchMaxCallsPerRound: parsePositiveInteger(
      env.WEB_SEARCH_MAX_CALLS_PER_ROUND,
      2,
      "WEB_SEARCH_MAX_CALLS_PER_ROUND",
    ),
    webSearchMaxCallsPerRequest: parsePositiveInteger(
      env.WEB_SEARCH_MAX_CALLS_PER_REQUEST,
      4,
      "WEB_SEARCH_MAX_CALLS_PER_REQUEST",
    ),
    braveApiKey: env.BRAVE_API_KEY?.trim() || null,
    tavilyApiKey: env.TAVILY_API_KEY?.trim() || null,
    grokBotGatewayUrl,
    grokBotToken,
    grokBotAgentId,
    grokBotTimeoutMs,
    bridgeHttpHost,
    bridgeHttpPort,
    bridgePublicUrl,
    bridgeReplyToken,
  };
}
