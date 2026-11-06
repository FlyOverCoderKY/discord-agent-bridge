import { describe, expect, it } from "vitest";
import { ConversationMemory } from "./memory.js";

describe("ConversationMemory", () => {
  it("caps history length by dropping oldest", () => {
    const mem = new ConversationMemory(2);
    mem.append("c", { role: "user", content: "1" });
    mem.append("c", { role: "assistant", content: "2" });
    mem.append("c", { role: "user", content: "3" });
    expect(mem.get("c").map((m) => m.content)).toEqual(["2", "3"]);
  });

  it("evicts the least recently used conversation above the key cap", () => {
    const mem = new ConversationMemory(2, 2);
    mem.append("old", { role: "user", content: "old" });
    mem.append("kept", { role: "user", content: "kept" });
    expect(mem.get("old")).toHaveLength(1);

    mem.append("new", { role: "user", content: "new" });

    expect(mem.size).toBe(2);
    expect(mem.get("kept")).toEqual([]);
    expect(mem.get("old")[0]?.content).toBe("old");
    expect(mem.get("new")[0]?.content).toBe("new");
  });
});
