/**
 * OAG PyRCA Bridge - TypeScript interface to Python PyRCA
 *
 * Provides Bayesian root cause analysis by calling the Python bridge
 * script. Falls back to regex-based classification if Python/PyRCA
 * is unavailable.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { classifyRootCause, type CrashRootCause, type RootCauseResult } from "../oag-root-cause.js";

const log = createSubsystemLogger("oag/pyrca");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, "oag_pyrca_bridge.py");

export type PyRCARootCause = {
  cause: string;
  probability: number;
  evidence: string[];
  category: string;
};

export type PyRCAResult = {
  root_causes: PyRCARootCause[];
  pyrca_available: boolean;
};

/**
 * Check if Python 3 is available in the environment.
 */
async function checkPythonAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("python3", ["--version"], { timeout: 2000 });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

let pythonAvailable: boolean | null = null;

/**
 * Run the PyRCA bridge and return Bayesian root cause candidates.
 */
export async function runPyRCAClassification(
  errorMessage: string,
  options?: {
    topologyPath?: string;
    historicalPath?: string;
    timeout?: number;
  },
): Promise<PyRCAResult | null> {
  // Cache Python availability check
  if (pythonAvailable === null) {
    pythonAvailable = await checkPythonAvailable();
    if (!pythonAvailable) {
      log.warn("Python 3 not available, PyRCA bridge disabled");
    }
  }

  if (!pythonAvailable) {
    return null;
  }

  const timeout = options?.timeout ?? 5000;

  return new Promise((resolve) => {
    const args = ["--error", errorMessage, "--format", "json"];

    if (options?.topologyPath) {
      args.push("--topology", options.topologyPath);
    }
    if (options?.historicalPath) {
      args.push("--historical", options.historicalPath);
    }

    let stdout = "";
    let stderr = "";

    const proc = spawn("python3", [BRIDGE_SCRIPT, ...args], {
      timeout,
      windowsHide: true,
    });

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        log.debug?.(`PyRCA bridge exited with code ${code}: ${stderr}`);
        resolve(null);
        return;
      }

      try {
        const result = JSON.parse(stdout) as PyRCAResult;
        resolve(result);
      } catch {
        log.debug?.(`Failed to parse PyRCA output: ${stdout}`);
        resolve(null);
      }
    });

    proc.on("error", (err) => {
      log.debug?.(`PyRCA bridge error: ${err.message}`);
      resolve(null);
    });
  });
}

/**
 * Hybrid root cause classification that combines regex patterns with
 * Bayesian inference from PyRCA.
 *
 * Strategy:
 * 1. Run fast regex classification first
 * 2. If confidence is low (< 0.8), run PyRCA for additional candidates
 * 3. Merge and rank results
 */
export async function classifyRootCauseHybrid(
  lastError: string | undefined | null,
): Promise<RootCauseResult & { alternatives?: PyRCARootCause[] }> {
  // Always run the fast regex classifier first
  const regexResult = classifyRootCause(lastError);

  // If high confidence, return immediately
  if (regexResult.confidence >= 0.8) {
    return regexResult;
  }

  // For low confidence, try PyRCA for additional insights
  if (lastError) {
    const pyrcaResult = await runPyRCAClassification(lastError);

    if (pyrcaResult && pyrcaResult.root_causes.length > 0) {
      const topCandidate = pyrcaResult.root_causes[0];

      // If PyRCA has higher confidence, use its classification
      if (topCandidate.probability > regexResult.confidence) {
        log.info(
          `PyRCA override: ${regexResult.cause} -> ${topCandidate.cause} (${topCandidate.probability})`,
        );

        return {
          cause: topCandidate.cause as CrashRootCause,
          confidence: topCandidate.probability,
          category: topCandidate.category as RootCauseResult["category"],
          shouldRetry: regexResult.shouldRetry,
          shouldNotifyOperator: regexResult.shouldNotifyOperator,
          shouldAdjustConfig: regexResult.shouldAdjustConfig,
          alternatives: pyrcaResult.root_causes.slice(1),
        };
      }

      // Otherwise, keep regex result but include alternatives
      return {
        ...regexResult,
        alternatives: pyrcaResult.root_causes.filter((c) => c.cause !== regexResult.cause),
      };
    }
  }

  return regexResult;
}

/**
 * Build a causal graph from service call logs for RCA.
 * This uses PyRCA's PC algorithm to infer causal relationships.
 */
export async function buildCausalGraph(
  _logs: Array<{ service: string; target: string; timestamp: number }>,
): Promise<unknown> {
  // This would require writing logs to a temp file and calling the bridge
  // For now, return null until we implement the full integration
  log.debug?.("buildCausalGraph not yet implemented");
  return null;
}
