import fs from "node:fs/promises";
import path from "node:path";

function getOagChannelHealthPath(): string | undefined {
  const home = process.env.HOME?.trim();
  return home ? `${home}/.openclaw/sentinel/channel-health-state.json` : undefined;
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
  } catch {
    return false;
  }
}
