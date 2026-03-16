import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (!mockFiles.has(p)) {
        throw new Error("ENOENT");
      }
      return mockFiles.get(p) ?? "";
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      mockFiles.set(p, content);
    }),
    rename: vi.fn(async (src: string, dest: string) => {
      const content = mockFiles.get(src);
      if (content !== undefined) {
        mockFiles.set(dest, content);
        mockFiles.delete(src);
      }
    }),
    mkdir: vi.fn(async () => {}),
  },
}));

const { injectEvolutionNote } = await import("./oag-evolution-notify.js");

describe("oag-evolution-notify", () => {
  const statePath = "/tmp/test-home/.openclaw/sentinel/channel-health-state.json";

  beforeEach(() => {
    mockFiles.clear();
    process.env.HOME = "/tmp/test-home";
  });

  it("injects a note into pending_user_notes", async () => {
    mockFiles.set(statePath, JSON.stringify({ pending_user_notes: [] }));
    const result = await injectEvolutionNote({
      message: "I improved recovery",
      evolutionId: "ev-123",
    });
    expect(result).toBe(true);
    const written = JSON.parse(mockFiles.get(statePath) ?? "{}");
    expect(written.pending_user_notes).toHaveLength(1);
    expect(written.pending_user_notes[0].id).toBe("oag-evolution:ev-123");
    expect(written.pending_user_notes[0].action).toBe("oag_evolution");
  });

  it("deduplicates by evolution ID", async () => {
    mockFiles.set(
      statePath,
      JSON.stringify({
        pending_user_notes: [
          {
            id: "oag-evolution:ev-123",
            action: "oag_evolution",
            message: "already there",
          },
        ],
      }),
    );
    const result = await injectEvolutionNote({
      message: "duplicate",
      evolutionId: "ev-123",
    });
    expect(result).toBe(false);
  });

  it("creates state file if missing", async () => {
    const result = await injectEvolutionNote({
      message: "first note",
      evolutionId: "ev-456",
    });
    expect(result).toBe(true);
    const written = JSON.parse(mockFiles.get(statePath) ?? "{}");
    expect(written.pending_user_notes).toHaveLength(1);
  });

  it("includes session keys as targets when provided", async () => {
    mockFiles.set(statePath, JSON.stringify({}));
    await injectEvolutionNote({
      message: "targeted",
      evolutionId: "ev-789",
      sessionKeys: ["telegram:+1234"],
    });
    const written = JSON.parse(mockFiles.get(statePath) ?? "{}");
    expect(written.pending_user_notes[0].targets).toEqual([{ sessionKeys: ["telegram:+1234"] }]);
  });
});
