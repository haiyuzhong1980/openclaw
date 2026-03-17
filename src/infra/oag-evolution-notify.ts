import fs from "node:fs/promises";
import path from "node:path";

const OAG_STATE_LOCK_SUFFIX = ".lock";
const OAG_STATE_LOCK_RETRY_MS = 25;
const OAG_STATE_LOCK_TIMEOUT_MS = 5_000;
const OAG_STATE_LOCK_STALE_MS = 30_000;

function getOagChannelHealthPath(): string | undefined {
  const home = process.env.HOME?.trim();
  return home ? `${home}/.openclaw/sentinel/channel-health-state.json` : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const pid = Number.parseInt(content.trim().split("\n")[0] ?? "", 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return true;
    }
    try {
      process.kill(pid, 0);
      const stat = await fs.stat(lockPath);
      return Date.now() - stat.mtimeMs > staleMs;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

async function withEvolutionLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}${OAG_STATE_LOCK_SUFFIX}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + OAG_STATE_LOCK_TIMEOUT_MS;
  let fd: import("node:fs/promises").FileHandle | null = null;
  while (true) {
    try {
      fd = await fs.open(lockPath, "wx");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (await isLockStale(lockPath, OAG_STATE_LOCK_STALE_MS)) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring evolution lock for ${statePath}`, { cause: error });
      }
      await sleep(OAG_STATE_LOCK_RETRY_MS);
    }
  }
  try {
    await fd.writeFile(String(process.pid), "utf8");
    return await fn();
  } finally {
    await fd.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function injectEvolutionNote(params: {
  message: string;
  evolutionId: string;
  sessionKeys?: string[];
}): Promise<boolean> {
  const statePath = getOagChannelHealthPath();
  if (!statePath) {
    return false;
  }

  try {
    return await withEvolutionLock(statePath, async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      const pending = Array.isArray(parsed.pending_user_notes) ? parsed.pending_user_notes : [];

      // Dedup by evolution ID — don't inject twice for the same evolution
      const alreadyInjected = pending.some(
        (note: Record<string, unknown>) => note.id === `oag-evolution:${params.evolutionId}`,
      );
      if (alreadyInjected) {
        return false;
      }

      const note = {
        id: `oag-evolution:${params.evolutionId}`,
        action: "oag_evolution",
        created_at: new Date().toISOString(),
        message: params.message,
        targets: params.sessionKeys?.length ? [{ sessionKeys: params.sessionKeys }] : [],
      };

      pending.push(note);
      parsed.pending_user_notes = pending;

      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      await fs.rename(tmp, statePath);

      return true;
    });
  } catch {
    return false;
  }
}
