import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to maxPerWindow then blocks", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.tryConsume("u", 1000)).toBe(true);
    expect(limiter.tryConsume("u", 1001)).toBe(true);
    expect(limiter.tryConsume("u", 1002)).toBe(false);
  });

  it("expires hits after the window", () => {
    const limiter = new RateLimiter(1, 100);
    expect(limiter.tryConsume("u", 0)).toBe(true);
    expect(limiter.tryConsume("u", 50)).toBe(false);
    expect(limiter.tryConsume("u", 101)).toBe(true);
  });

  it("prunes expired buckets and fails closed at the active-key cap", () => {
    const limiter = new RateLimiter(2, 100, 2);
    expect(limiter.tryConsume("a", 0)).toBe(true);
    expect(limiter.tryConsume("b", 1)).toBe(true);
    expect(limiter.tryConsume("c", 2)).toBe(false);
    expect(limiter.size).toBe(2);

    expect(limiter.tryConsume("c", 102)).toBe(true);
    expect(limiter.size).toBe(1);
  });
});
