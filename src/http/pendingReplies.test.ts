import { describe, expect, it } from "vitest";
import { PendingReplyStore, ReplyTimeoutError } from "./pendingReplies.js";

describe("PendingReplyStore.complete", () => {
  it("does not resolve generate() when delivery fails, and a later retry can succeed", async () => {
    const pending = new PendingReplyStore();
    let attempts = 0;
    const registration = pending.register("id-1", 5_000, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient discord error");
    });

    await expect(
      pending.complete("id-1", registration.capabilityToken, "retry me"),
    ).resolves.toBe("delivery_failed");
    expect(pending.has("id-1")).toBe(true);

    let settled = false;
    void registration.reply.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    await expect(
      pending.complete("id-1", registration.capabilityToken, "retry me"),
    ).resolves.toBe("ok");
    await expect(registration.reply).resolves.toBe("retry me");
    expect(attempts).toBe(2);
    expect(pending.has("id-1")).toBe(false);
  });

  it("isolates capabilities by correlationId and invalidates them after completion", async () => {
    const pending = new PendingReplyStore("server-side-key");
    const first = pending.register("id-1", 5_000);
    const second = pending.register("id-2", 5_000);

    expect(first.capabilityToken).not.toBe(second.capabilityToken);
    await expect(pending.complete("id-1", second.capabilityToken, "wrong token")).resolves.toBe(
      "unauthorized",
    );
    await expect(pending.complete("id-1", first.capabilityToken, "first")).resolves.toBe("ok");
    await expect(first.reply).resolves.toBe("first");
    await expect(pending.complete("id-1", first.capabilityToken, "replay")).resolves.toBe(
      "missing",
    );

    await expect(pending.complete("id-2", second.capabilityToken, "second")).resolves.toBe("ok");
    await expect(second.reply).resolves.toBe("second");
  });

  it("bounds delivery retries for one capability", async () => {
    const pending = new PendingReplyStore();
    let attempts = 0;
    const registration = pending.register("bounded-retries", 5_000, async () => {
      attempts += 1;
      throw new Error("delivery failed");
    });

    await expect(
      pending.complete("bounded-retries", registration.capabilityToken, "reply"),
    ).resolves.toBe("delivery_failed");
    await expect(
      pending.complete("bounded-retries", registration.capabilityToken, "reply"),
    ).resolves.toBe("delivery_failed");
    await expect(
      pending.complete("bounded-retries", registration.capabilityToken, "reply"),
    ).resolves.toBe("delivery_failed");
    expect(attempts).toBe(2);

    pending.fail("bounded-retries", new Error("test cleanup"));
    await expect(registration.reply).rejects.toThrow("test cleanup");
  });

  it("expires a capability while Discord delivery is still pending", async () => {
    const pending = new PendingReplyStore();
    const registration = pending.register("delivery-timeout", 20, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    await expect(
      pending.complete("delivery-timeout", registration.capabilityToken, "slow"),
    ).resolves.toBe("missing");
    await expect(registration.reply).rejects.toBeInstanceOf(ReplyTimeoutError);
    expect(pending.has("delivery-timeout")).toBe(false);
  });
});
