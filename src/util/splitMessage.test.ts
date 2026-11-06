import { describe, expect, it } from "vitest";
import { splitMessage } from "./splitMessage.js";

describe("splitMessage", () => {
  it("returns empty for blank input", () => {
    expect(splitMessage("   ")).toEqual([]);
  });

  it("returns a single chunk when under limit", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits long text near newlines", () => {
    const a = "A".repeat(100);
    const b = "B".repeat(100);
    const text = `${a}\n\n${b}`;
    const chunks = splitMessage(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").replace(/\s/g, "")).toBe(`${a}${b}`);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(120);
    }
  });

  it("hard-splits when no breakpoints exist", () => {
    const text = "X".repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it("caps chunk fan-out and marks the truncated final chunk", () => {
    const chunks = splitMessage("X".repeat(200), 40, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toContain("[Reply truncated.]");
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
  });

  it("rejects non-positive split bounds", () => {
    expect(() => splitMessage("hello", 0)).toThrow(/positive integer/);
    expect(() => splitMessage("hello", 10, 0)).toThrow(/positive integer/);
  });
});
