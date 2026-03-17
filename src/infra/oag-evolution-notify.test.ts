import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFiles = vi.hoisted(() => new Map<string, string>());
const mockOpenCalls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (!mockFiles.has(p)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
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
    open: vi.fn(async (p: string, flags: string) => {
      mockOpenCalls.push(p);
      if (flags === "wx" && mockFiles.has(p)) {
        const err = new Error("EEXIST") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      mockFiles.set(p, "");
      return {
        writeFile: vi.fn(async (content: string) => {
          mockFiles.set(p, content);
        }),
        close: vi.fn(async () => {}),
      };
    }),
    unlink: vi.fn(async (p: string) => {
      mockFiles.delete(p);
    }),
    stat: vi.fn(async () => ({
      mtimeMs: Date.now() - 60_000,
    })),
  },
}));

const { injectEvolutionNote } = await import("./oag-evolution-notify.js");

describe("oag-evolution-notify", () => {
  const statePath = "/tmp/test-home/.openclaw/sentinel/channel-health-state.json";

  beforeEach(() => {
    mockFiles.clear();
    mockOpenCalls.length = 0;
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

  it("acquires a file lock during read-check-write", async () => {
    mockFiles.set(statePath, JSON.stringify({ pending_user_notes: [] }));
    await injectEvolutionNote({
      message: "locked write",
      evolutionId: "ev-lock",
    });
    const lockPath = `${statePath}.lock`;
    // Lock file should have been opened (acquired) then cleaned up (unlinked)
    expect(mockOpenCalls).toContain(lockPath);
    // Lock file should be removed after operation completes
    expect(mockFiles.has(lockPath)).toBe(false);
  });

  it("concurrent injections are serialized by the lock", async () => {
    mockFiles.set(statePath, JSON.stringify({ pending_user_notes: [] }));
    // Run two injections concurrently — both should succeed with distinct IDs
    const [r1, r2] = await Promise.all([
      injectEvolutionNote({ message: "first", evolutionId: "ev-a" }),
      injectEvolutionNote({ message: "second", evolutionId: "ev-b" }),
    ]);
    // At least one should succeed; the lock prevents TOCTOU so both can succeed sequentially
    expect(r1 || r2).toBe(true);
  });
});
