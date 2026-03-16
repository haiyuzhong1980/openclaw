import { describe, expect, it } from "vitest";
import {
  resolveOagDeliveryMaxRetries,
  resolveOagDeliveryRecoveryBudgetMs,
  resolveOagLockTimeoutMs,
  resolveOagLockStaleMs,
  resolveOagStalePollFactor,
  resolveOagNoteDedupWindowMs,
  resolveOagMaxDeliveredNotes,
} from "./oag-config.js";

describe("oag-config resolvers", () => {
  it("returns defaults when config is undefined", () => {
    expect(resolveOagDeliveryMaxRetries()).toBe(5);
    expect(resolveOagDeliveryRecoveryBudgetMs()).toBe(60_000);
    expect(resolveOagLockTimeoutMs()).toBe(2_000);
    expect(resolveOagLockStaleMs()).toBe(30_000);
    expect(resolveOagStalePollFactor()).toBe(2);
    expect(resolveOagNoteDedupWindowMs()).toBe(60_000);
    expect(resolveOagMaxDeliveredNotes()).toBe(20);
  });

  it("returns defaults when gateway.oag is absent", () => {
    expect(resolveOagDeliveryMaxRetries({ gateway: {} })).toBe(5);
    expect(resolveOagLockTimeoutMs({ gateway: { oag: {} } })).toBe(2_000);
  });

  it("returns overridden values when set", () => {
    const cfg = { gateway: { oag: { delivery: { maxRetries: 10 }, lock: { staleMs: 60_000 } } } };
    expect(resolveOagDeliveryMaxRetries(cfg)).toBe(10);
    expect(resolveOagLockStaleMs(cfg)).toBe(60_000);
    // Non-overridden values still return defaults
    expect(resolveOagLockTimeoutMs(cfg)).toBe(2_000);
  });

  it("ignores invalid values and returns defaults", () => {
    const cfg = { gateway: { oag: { delivery: { maxRetries: -1 }, lock: { staleMs: 0 } } } };
    expect(resolveOagDeliveryMaxRetries(cfg)).toBe(5);
    expect(resolveOagLockStaleMs(cfg)).toBe(30_000);
  });

  it("allows dedupWindowMs to be zero (disables dedup)", () => {
    const cfg = { gateway: { oag: { notes: { dedupWindowMs: 0 } } } };
    expect(resolveOagNoteDedupWindowMs(cfg)).toBe(0);
  });
});
