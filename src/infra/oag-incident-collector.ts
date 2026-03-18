import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitOagEvent } from "./oag-event-bus.js";
import type { OagIncident } from "./oag-memory.js";

const log = createSubsystemLogger("oag/incident-collector");

const activeIncidents = new Map<string, OagIncident>();

const MAX_ACTIVE_INCIDENTS = 1000;

export function recordOagIncident(
  incident: Omit<OagIncident, "firstAt" | "lastAt" | "count">,
): void {
  const key = `${incident.type}:${incident.channel ?? "all"}`;
  const existing = activeIncidents.get(key);
  const now = new Date().toISOString();
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    existing.detail = incident.detail;
    if (incident.lastError !== undefined) {
      existing.lastError = incident.lastError;
    }
  } else {
    activeIncidents.set(key, {
      ...incident,
      count: 1,
      firstAt: now,
      lastAt: now,
    });
  }
  if (activeIncidents.size > MAX_ACTIVE_INCIDENTS) {
    // Maps preserve insertion order; evict the oldest entry (first key) to stay under cap.
    const oldestKey = activeIncidents.keys().next().value;
    if (oldestKey !== undefined) {
      activeIncidents.delete(oldestKey);
      log.warn(
        `activeIncidents cap (${MAX_ACTIVE_INCIDENTS}) reached; evicted oldest incident key="${oldestKey}"`,
      );
    }
  }
  emitOagEvent("incident_recorded", {
    type: incident.type,
    channel: incident.channel,
    detail: incident.detail,
  });
}

export function collectActiveIncidents(): OagIncident[] {
  return Array.from(activeIncidents.values());
}

export function clearActiveIncidents(): void {
  activeIncidents.clear();
}

export function resolveIncidentOutcome(key: string, recoveryMs: number): void {
  const existing = activeIncidents.get(key);
  if (existing) {
    existing.resolvedAt = new Date().toISOString();
    existing.recoveryMs = recoveryMs;
  }
}
