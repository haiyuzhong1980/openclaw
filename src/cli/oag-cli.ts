import type { Command } from "commander";
import {
  oagHistoryCommand,
  oagIncidentsCommand,
  oagStatusCommand,
} from "../commands/oag.command.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function runOagCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

export function registerOagCli(program: Command) {
  const oag = program
    .command("oag")
    .description("Inspect OAG (Operational Autonomous Guardian) metrics, history, and incidents")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw oag status", "Show current OAG metrics and observation state."],
          ["openclaw oag history", "Show lifecycle, evolution, and diagnosis history."],
          ["openclaw oag history --limit 5", "Limit history output to 5 entries."],
          ["openclaw oag incidents", "Show active incidents (last 24h)."],
          ["openclaw oag incidents --json", "Output active incidents as JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/oag", "docs.openclaw.ai/cli/oag")}\n`,
    );

  oag
    .command("status")
    .description("Show current OAG runtime metrics and observation state")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      await runOagCommand(async () => {
        await oagStatusCommand(opts, defaultRuntime);
      }, "OAG status failed");
    });

  oag
    .command("history")
    .description("Show OAG lifecycle, evolution, and diagnosis history from oag-memory.json")
    .option("--limit <n>", "Maximum entries to show per section", "20")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean; limit?: string }) => {
      await runOagCommand(async () => {
        await oagHistoryCommand(opts, defaultRuntime);
      }, "OAG history failed");
    });

  oag
    .command("incidents")
    .description("Show active OAG incidents (last 24 hours)")
    .option("--limit <n>", "Maximum incidents to show", "20")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean; limit?: string }) => {
      await runOagCommand(async () => {
        await oagIncidentsCommand(opts, defaultRuntime);
      }, "OAG incidents failed");
    });
}
