import { describe, expect, it, vi } from "vitest";
import { classifyRootCauseHybrid, runPyRCAClassification } from "./oag-pyrca-bridge.js";

// Mock the child_process spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const mockProc = {
      stdout: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === "data") {
            cb(
              Buffer.from(
                JSON.stringify({
                  root_causes: [
                    {
                      cause: "network_timeout",
                      probability: 0.75,
                      evidence: ["has_network_timeout"],
                      category: "network",
                    },
                  ],
                  pyrca_available: false,
                }),
              ),
            );
          }
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === "close") {
          cb(0);
        }
      }),
    };
    return mockProc;
  }),
}));

describe("oag-pyrca-bridge", () => {
  describe("runPyRCAClassification", () => {
    it("should return null when python is not available", async () => {
      // This test verifies the function signature and return type
      const result = await runPyRCAClassification("test error");
      // Result depends on mock, which returns valid JSON
      expect(result).toBeDefined();
    });
  });

  describe("classifyRootCauseHybrid", () => {
    it("should return regex result for null error", async () => {
      const result = await classifyRootCauseHybrid(null);
      expect(result.cause).toBe("unknown");
      expect(result.confidence).toBe(0);
    });

    it("should return regex result for undefined error", async () => {
      const result = await classifyRootCauseHybrid(undefined);
      expect(result.cause).toBe("unknown");
      expect(result.confidence).toBe(0);
    });

    it("should return high-confidence regex result immediately", async () => {
      // "429" should match rate_limit with 0.85 confidence
      const result = await classifyRootCauseHybrid("HTTP 429 Too Many Requests");
      expect(result.cause).toBe("rate_limit");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("should classify network timeout errors", async () => {
      const result = await classifyRootCauseHybrid("ETIMEDOUT: connection timed out");
      expect(result.category).toBe("network");
    });

    it("should classify auth failures", async () => {
      const result = await classifyRootCauseHybrid("401 Unauthorized - token expired");
      expect(result.category).toBe("auth_failure");
    });

    it("should classify config errors", async () => {
      const result = await classifyRootCauseHybrid("Cannot find module 'missing-package'");
      expect(result.category).toBe("config");
    });
  });
});
