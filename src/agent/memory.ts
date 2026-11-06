export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/**
 * In-memory per-channel / thread conversation history with a message-count cap.
 * System prompt is not stored here; backends prepend it at request time.
 */
export class ConversationMemory {
  private readonly store = new Map<string, ChatMessage[]>();

  constructor(
    private readonly maxMessages: number,
    private readonly maxKeys = 1_000,
  ) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new Error("maxMessages must be a positive integer");
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error("maxKeys must be a positive integer");
    }
  }

  get(key: string): ChatMessage[] {
    const list = this.store.get(key);
    if (!list) return [];
    this.touch(key, list);
    return [...list];
  }

  append(key: string, message: ChatMessage): void {
    const list = this.store.get(key) ?? [];
    list.push(message);
    while (list.length > this.maxMessages) {
      list.shift();
    }
    this.touch(key, list);
    while (this.store.size > this.maxKeys) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  clear(key?: string): void {
    if (key === undefined) this.store.clear();
    else this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  private touch(key: string, messages: ChatMessage[]): void {
    this.store.delete(key);
    this.store.set(key, messages);
  }
}
