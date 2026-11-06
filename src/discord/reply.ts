import type { Message, TextChannel } from "discord.js";
import { splitMessage } from "../util/splitMessage.js";

export async function sendSplitReply(
  message: Message,
  text: string,
  maxChunks?: number,
): Promise<void> {
  const chunks = splitMessage(text, undefined, maxChunks);
  if (chunks.length === 0) return;

  const channel = message.channel as TextChannel;
  let first = true;
  for (const chunk of chunks) {
    if (first) {
      await message.reply({
        content: chunk,
        allowedMentions: { parse: [], repliedUser: false },
      });
      first = false;
    } else {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }
}

export async function withTyping<T>(
  message: Message,
  work: () => Promise<T>,
): Promise<T> {
  const channel = message.channel as TextChannel;
  await channel.sendTyping().catch(() => undefined);
  const interval = setInterval(() => {
    void channel.sendTyping().catch(() => undefined);
  }, 8_000);
  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
}
