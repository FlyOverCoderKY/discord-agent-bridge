import "dotenv/config";
import type { AgentBackend } from "./agent/backend.js";
import { GrokBotBackend, joinUrl } from "./agent/grokBot.js";
import { OpenAICompatibleBackend } from "./agent/openaiCompatible.js";
import { loadConfig } from "./config.js";
import { startBot } from "./discord/bot.js";
import { PendingReplyStore } from "./http/pendingReplies.js";
import { startReplyServer } from "./http/replyServer.js";

function createOpenAiBackend(config: ReturnType<typeof loadConfig>): AgentBackend {
  return new OpenAICompatibleBackend({
    apiBaseUrl: config.apiBaseUrl!,
    apiKey: config.apiKey!,
    model: config.model!,
    systemPrompt: config.systemPrompt,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    memoryMaxMessages: config.memoryMaxMessages,
    memoryMaxKeys: config.memoryMaxKeys,
    maxWebSearchCallsPerRound: config.webSearchMaxCallsPerRound,
    maxWebSearchCallsPerRequest: config.webSearchMaxCallsPerRequest,
    braveApiKey: config.braveApiKey,
    tavilyApiKey: config.tavilyApiKey,
  });
}

async function createGrokBotBackend(config: ReturnType<typeof loadConfig>): Promise<AgentBackend> {
  const pending = new PendingReplyStore(config.bridgeReplyToken!);
  const replyUrl = joinUrl(config.bridgePublicUrl!, "/internal/reply");
  const server = await startReplyServer({
    host: config.bridgeHttpHost,
    port: config.bridgeHttpPort,
    pending,
    maxTextChars: config.callbackMaxTextChars,
  });
  console.log(`[bridge] reply endpoint listening on ${server.host}:${server.port} path=/internal/reply`);
  return new GrokBotBackend({
    gatewayUrl: config.grokBotGatewayUrl!,
    token: config.grokBotToken!,
    agentId: config.grokBotAgentId!,
    timeoutMs: config.grokBotTimeoutMs,
    replyUrl,
    pending,
  });
}

async function createBackend(config: ReturnType<typeof loadConfig>): Promise<AgentBackend> {
  if (config.agentBackend === "grok-bot") {
    return createGrokBotBackend(config);
  }
  return createOpenAiBackend(config);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const grokBits =
    config.agentBackend === "grok-bot"
      ? ` gateway=${config.grokBotGatewayUrl} agentId=${config.grokBotAgentId} publicUrl=${config.bridgePublicUrl}`
      : "";
  console.log(
    `[bridge] backend=${config.agentBackend}` +
      (config.model ? ` model=${config.model}` : "") +
      (config.apiBaseUrl ? ` base=${config.apiBaseUrl}` : "") +
      grokBits +
      ` soul=${config.systemPromptFile}`,
  );
  const backend = await createBackend(config);
  await startBot(config, backend);
}

main().catch((err) => {
  console.error("[bridge] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
