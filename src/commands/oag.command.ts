import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import type {
  OagDiagnosisRecord,
  OagEvolutionRecord,
  OagIncident,
  OagLifecycle,
  OagMemory,
} from "../infra/oag-memory.js";
import { loadOagMemory } from "../infra/oag-memory.js";
import { getOagMetrics } from "../infra/oag-metrics.js";
import type { RuntimeEnv } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";

const DEFAULT_LIMIT = 20;

function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

function formatIncidentType(type: string): string {
  return type.replace(/_/g, " ");
}

function formatStopReason(reason: string): string {
  if (reason === "clean") {
    return theme.success("clean");
  }
  if (reason === "crash") {
    return theme.error("crash");
  }
  if (reason === "restart") {
    return theme.warn("restart");
  }
  return theme.muted(reason);
}

function formatOutcome(outcome?: string): string {
  if (outcome === "effective") {
    return theme.success("effective");
  }
  if (outcome === "reverted") {
    return theme.warn("reverted");
  }
  if (outcome === "pending") {
    return theme.muted("pending");
  }
  return theme.muted(outcome ?? "unknown");
}

function formatRisk(risk: string): string {
  if (risk === "high") {
    return theme.error("high");
  }
  if (risk === "medium") {
    return theme.warn("medium");
  }
  return theme.muted(risk);
}

// --- Status subcommand ---

function buildStatusJson(memory: OagMemory) {
  const metrics = getOagMetrics();
  const recentCrashes = memory.lifecycles.filter(
    (lc) => lc.stopReason === "crash" && Date.now() - Date.parse(lc.stoppedAt) < 24 * 60 * 60_000,
  );
  const activeIncidents = memory.lifecycles
    .flatMap((lc) => lc.incidents)
    .filter((inc) => {
      const lastAt = Date.parse(inc.lastAt);
      return Number.isFinite(lastAt) && Date.now() - lastAt < 24 * 60 * 60_000;
    });
  return {
    metrics,
    lifecycles: memory.lifecycles.length,
    evolutions: memory.evolutions.length,
    diagnoses: memory.diagnoses.length,
    recentCrashes: recentCrashes.length,
    activeIncidents: activeIncidents.length,
    activeObservation: memory.activeObservation ?? null,
  };
}

export async function oagStatusCommand(
  opts: { json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const memory = await loadOagMemory();

  if (opts.json) {
    runtime.log(JSON.stringify(buildStatusJson(memory), null, 2));
    return;
  }

  const metrics = getOagMetrics();
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  runtime.log(theme.heading("OAG Status"));
  runtime.log("");

  const rows = [
    { Item: "Channel restarts", Value: String(metrics.channelRestarts) },
    { Item: "Delivery recoveries", Value: String(metrics.deliveryRecoveries) },
    { Item: "Recovery failures", Value: String(metrics.deliveryRecoveryFailures) },
    { Item: "Stale socket detections", Value: String(metrics.staleSocketDetections) },
    { Item: "Stale poll detections", Value: String(metrics.stalePollDetections) },
    { Item: "Note deliveries", Value: String(metrics.noteDeliveries) },
    { Item: "Note deduplications", Value: String(metrics.noteDeduplications) },
    { Item: "Lock acquisitions", Value: String(metrics.lockAcquisitions) },
    { Item: "Lock stale recoveries", Value: String(metrics.lockStalRecoveries) },
    { Item: "Lifecycles recorded", Value: String(memory.lifecycles.length) },
    { Item: "Evolutions recorded", Value: String(memory.evolutions.length) },
    { Item: "Diagnoses recorded", Value: String(memory.diagnoses.length) },
  ];

  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 22 },
        { key: "Value", header: "Value", flex: true, minWidth: 10 },
      ],
      rows,
    }).trimEnd(),
  );

  if (memory.activeObservation) {
    runtime.log("");
    runtime.log(theme.heading("Active Observation"));
    const obs = memory.activeObservation;
    const age = Date.now() - Date.parse(obs.evolutionAppliedAt);
    runtime.log(`  Applied: ${formatTimeAgo(age)} · window: ${Math.round(obs.windowMs / 60_000)}m`);
    runtime.log(`  Rollback targets: ${obs.rollbackChanges.length} config path(s)`);
  }
}

// --- History subcommand ---

function buildHistoryJson(memory: OagMemory, limit: number) {
  return {
    lifecycles: memory.lifecycles.slice(-limit),
    evolutions: memory.evolutions.slice(-limit),
    diagnoses: memory.diagnoses.slice(-limit),
  };
}

export async function oagHistoryCommand(
  opts: { json?: boolean; limit?: unknown },
  runtime: RuntimeEnv,
): Promise<void> {
  const memory = await loadOagMemory();
  const limit = parseLimit(opts.limit);

  if (opts.json) {
    runtime.log(JSON.stringify(buildHistoryJson(memory, limit), null, 2));
    return;
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  // Lifecycles
  const lifecycles = memory.lifecycles.slice(-limit);
  runtime.log(theme.heading("Lifecycle History"));
  if (lifecycles.length === 0) {
    runtime.log(theme.muted("  No lifecycle records."));
  } else {
    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "ID", header: "ID", minWidth: 14 },
          { key: "Stop", header: "Stop", minWidth: 8 },
          { key: "Uptime", header: "Uptime", minWidth: 10 },
          { key: "Restarts", header: "Restarts", minWidth: 8 },
          { key: "Recoveries", header: "Recoveries", minWidth: 10 },
          { key: "Incidents", header: "Incidents", minWidth: 9 },
          { key: "Age", header: "Age", flex: true, minWidth: 8 },
        ],
        rows: lifecycles.map((lc: OagLifecycle) => ({
          ID: lc.id,
          Stop: formatStopReason(lc.stopReason),
          Uptime: formatTimeAgo(lc.uptimeMs, { suffix: false }),
          Restarts: String(lc.metricsSnapshot.channelRestarts ?? 0),
          Recoveries: String(lc.metricsSnapshot.deliveryRecoveries ?? 0),
          Incidents: String(lc.incidents.length),
          Age: formatTimeAgo(Date.now() - Date.parse(lc.stoppedAt)),
        })),
      }).trimEnd(),
    );
  }

  // Evolutions
  runtime.log("");
  runtime.log(theme.heading("Evolution History"));
  const evolutions = memory.evolutions.slice(-limit);
  if (evolutions.length === 0) {
    runtime.log(theme.muted("  No evolution records."));
  } else {
    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Applied", header: "Applied", minWidth: 10 },
          { key: "Source", header: "Source", minWidth: 10 },
          { key: "Outcome", header: "Outcome", minWidth: 10 },
          { key: "Changes", header: "Changes", flex: true, minWidth: 20 },
        ],
        rows: evolutions.map((evo: OagEvolutionRecord) => ({
          Applied: formatTimeAgo(Date.now() - Date.parse(evo.appliedAt)),
          Source: evo.source,
          Outcome: formatOutcome(evo.outcome),
          Changes:
            evo.changes
              ?.slice(0, 2)
              .map((c) => {
                const param = c.configPath?.split(".").pop() ?? "?";
                return `${param} ${String(c.from)}\u2192${String(c.to)}`;
              })
              .join(", ") ?? "",
        })),
      }).trimEnd(),
    );
  }

  // Diagnoses
  runtime.log("");
  runtime.log(theme.heading("Diagnosis History"));
  const diagnoses = memory.diagnoses.slice(-limit);
  if (diagnoses.length === 0) {
    runtime.log(theme.muted("  No diagnosis records."));
  } else {
    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "ID", header: "ID", minWidth: 12 },
          { key: "Trigger", header: "Trigger", minWidth: 14 },
          { key: "Root Cause", header: "Root Cause", flex: true, minWidth: 20 },
          { key: "Confidence", header: "Conf", minWidth: 6 },
          { key: "Recs", header: "Recs", minWidth: 5 },
        ],
        rows: diagnoses.map((d: OagDiagnosisRecord) => ({
          ID: d.id,
          Trigger: d.trigger,
          "Root Cause": d.rootCause,
          Confidence: `${Math.round(d.confidence * 100)}%`,
          Recs: String(d.recommendations.length),
        })),
      }).trimEnd(),
    );
  }
}

// --- Incidents subcommand ---

function collectActiveIncidents(memory: OagMemory): OagIncident[] {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const incidents: OagIncident[] = [];
  for (const lc of memory.lifecycles) {
    for (const inc of lc.incidents) {
      const lastAt = Date.parse(inc.lastAt);
      if (Number.isFinite(lastAt) && lastAt > cutoff) {
        incidents.push(inc);
      }
    }
  }
  return incidents.toSorted((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

function buildIncidentsJson(memory: OagMemory, limit: number) {
  const incidents = collectActiveIncidents(memory).slice(0, limit);
  return { activeIncidents: incidents.length, incidents };
}

export async function oagIncidentsCommand(
  opts: { json?: boolean; limit?: unknown },
  runtime: RuntimeEnv,
): Promise<void> {
  const memory = await loadOagMemory();
  const limit = parseLimit(opts.limit);

  if (opts.json) {
    runtime.log(JSON.stringify(buildIncidentsJson(memory, limit), null, 2));
    return;
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const incidents = collectActiveIncidents(memory).slice(0, limit);

  runtime.log(theme.heading("OAG Active Incidents (24h)"));
  runtime.log("");

  if (incidents.length === 0) {
    runtime.log(theme.success("  No active incidents."));
    return;
  }

  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Type", header: "Type", minWidth: 18 },
        { key: "Channel", header: "Channel", minWidth: 10 },
        { key: "Count", header: "Count", minWidth: 6 },
        { key: "Last", header: "Last", minWidth: 10 },
        { key: "Detail", header: "Detail", flex: true, minWidth: 20 },
      ],
      rows: incidents.map((inc: OagIncident) => ({
        Type: formatIncidentType(inc.type),
        Channel: inc.channel ?? theme.muted("all"),
        Count: String(inc.count),
        Last: formatTimeAgo(Date.now() - Date.parse(inc.lastAt)),
        Detail: inc.detail.length > 80 ? `${inc.detail.slice(0, 77)}...` : inc.detail,
      })),
    }).trimEnd(),
  );

  // Show diagnosis recommendations if any match recent incidents
  const recentDiagnoses = memory.diagnoses.filter(
    (d) => Date.now() - Date.parse(d.completedAt) < 24 * 60 * 60_000,
  );
  if (recentDiagnoses.length > 0) {
    runtime.log("");
    runtime.log(theme.heading("Recent Diagnoses"));
    for (const d of recentDiagnoses.slice(0, 3)) {
      runtime.log(`  ${theme.info(d.trigger)}: ${d.rootCause}`);
      for (const rec of d.recommendations.filter((r) => !r.applied)) {
        runtime.log(`    ${formatRisk(rec.risk)} ${rec.description}`);
      }
    }
  }
}
