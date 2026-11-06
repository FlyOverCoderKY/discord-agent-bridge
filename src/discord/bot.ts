import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type OmitPartialGroupDMChannel,
} from "discord.js";
import type { AgentBackend } from "../agent/backend.js";
import type { Config } from "../config.js";
import { evaluateAccess } from "./access.js";
import { RateLimiter } from "./rateLimit.js";
import { sendSplitReply, withTyping } from "./reply.js";

export function createDiscordClient(config: Config): Client {
  const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ];
  if (config.allowDms) {
    intents.push(GatewayIntentBits.DirectMessages);
  }

  return new Client({
    intents,
    partials: [Partials.Channel],
  });
}

function stripBotMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Memory key: threads use their own id so history does not bleed into the parent. */
export function conversationKey(message: Message): string {
  const channel = message.channel;
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    return `thread:${message.channelId}`;
  }
  return `channel:${message.channelId}`;
}


export function channelContext(message: Message): {
  channelName?: string;
  threadName?: string;
  channelTopic?: string | null;
  guildName?: string;
  parentChannelId?: string | null;
} {
  const guildName = message.guild?.name ?? undefined;
  const channel = message.channel;

  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    const parent = channel.parent;
    const parentName =
      parent && "name" in parent && typeof parent.name === "string" ? parent.name : undefined;
    const topic =
      parent && "topic" in parent && typeof parent.topic === "string" ? parent.topic : null;
    return {
      channelName: parentName ?? ("name" in channel ? channel.name : undefined),
      threadName: "name" in channel ? channel.name : undefined,
      channelTopic: topic,
      guildName,
      parentChannelId: channel.parentId ?? null,
    };
  }

  if ("name" in channel && typeof channel.name === "string") {
    const topic =
      "topic" in channel && typeof channel.topic === "string" ? channel.topic : null;
    return { channelName: channel.name, channelTopic: topic, guildName };
  }
  return { guildName };
}


export function attachMessageHandler(
  client: Client,
  config: Config,
  backend: AgentBackend,
): void {
  const limiter = new RateLimiter(
    config.rateLimitPerUser,
    config.rateLimitWindowMs,
    config.rateLimitMaxKeys,
  );

  client.on("messageCreate", async (message: OmitPartialGroupDMChannel<Message>) => {
    try {
      await handleMessage(client, config, backend, limiter, message);
    } catch (err) {
      console.error("[bridge] unhandled message error", err);
    }
  });
}

async function handleMessage(
  client: Client,
  config: Config,
  backend: AgentBackend,
  limiter: RateLimiter,
  message: Message,
): Promise<void> {
  if (!client.user) return;

  const isDm =
    message.channel.type === ChannelType.DM ||
    message.guild === null;

  const botMentioned = message.mentions.users.has(client.user.id);
  const authorRoleIds = message.member?.roles.cache.map((r) => r.id) ?? [];

  const ctx = channelContext(message);

  const access = evaluateAccess(
    {
      authorId: message.author.id,
      authorRoleIds,
      channelId: message.channelId,
      parentChannelId: ctx.parentChannelId,
      guildId: message.guildId,
      isDm,
      botMentioned,
      isBot: message.author.bot,
      isSelf: message.author.id === client.user.id,
    },
    {
      allowAllUsers: config.allowAllUsers,
      allowedUsers: config.allowedUsers,
      allowedRoles: config.allowedRoles,
      allowedGuilds: config.allowedGuilds,
      allowDms: config.allowDms,
      dmOnly: config.dmOnly,
      freeResponseChannels: config.freeResponseChannels,
      requireMention: config.requireMention,
    },
  );

  if (!access.allowed) return;

  if (!limiter.tryConsume(message.author.id)) {
    await message.reply({
      content: "You're sending messages too quickly — try again in a minute.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const content = stripBotMention(message.content, client.user.id);
  if (!content) {
    await message.reply({
      content: isDm
        ? "Send me a message with what you need help with."
        : "Mention me with a question (or say something in a free-response channel).",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  try {
    const result = await withTyping(message, () =>
      backend.generate({
        conversationKey: conversationKey(message),
        authorDisplayName: message.member?.displayName ?? message.author.username,
        content,
        channelName: ctx.channelName,
        threadName: ctx.threadName,
        channelTopic: ctx.channelTopic,
        guildName: ctx.guildName,
        deliverReply: (text) => sendSplitReply(message, text, config.discordReplyMaxChunks),
      }),
    );
    if (!result.delivered) {
      await sendSplitReply(message, result.text, config.discordReplyMaxChunks);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[bridge] agent error:", detail);
    await message.reply({
      content: "Sorry — I hit an error generating a reply. Try again shortly.",
      allowedMentions: { repliedUser: false },
    });
  }
}

export async function startBot(config: Config, backend: AgentBackend): Promise<Client> {
  const client = createDiscordClient(config);
  attachMessageHandler(client, config, backend);

  client.once(Events.ClientReady, () => {
    console.log(`[bridge] logged in as ${client.user?.tag} (backend=${backend.name})`);
    if (config.homeChannel) {
      console.log(`[bridge] home channel configured: ${config.homeChannel}`);
    }
    if (config.allowDms) {
      console.log(`[bridge] DMs enabled${config.dmOnly ? " (DM-only mode)" : ""}`);
    }
  });

  await client.login(config.discordToken);
  return client;
}
