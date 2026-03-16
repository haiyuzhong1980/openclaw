import { loadConfig, writeConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("oag/config-writer");

type ConfigChange = {
  configPath: string;
  value: unknown;
};

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

export async function applyOagConfigChanges(
  changes: ConfigChange[],
  options?: { dryRun?: boolean },
): Promise<{ applied: boolean; config?: OpenClawConfig }> {
  if (changes.length === 0) {
    return { applied: false };
  }

  const currentConfig = loadConfig();
  const nextConfig: OpenClawConfig = JSON.parse(JSON.stringify(currentConfig));

  for (const change of changes) {
    log.info(`OAG config change: ${change.configPath} = ${JSON.stringify(change.value)}`);
    setNestedValue(nextConfig as Record<string, unknown>, change.configPath, change.value);
  }

  if (options?.dryRun) {
    log.info("OAG config changes computed (dry-run, not persisted)");
    return { applied: false, config: nextConfig };
  }

  try {
    await writeConfigFile(nextConfig);
    log.info(`OAG config persisted with ${changes.length} change(s)`);
    return { applied: true, config: nextConfig };
  } catch (err) {
    log.error(`Failed to write OAG config changes: ${String(err)}`);
    return { applied: false };
  }
}
