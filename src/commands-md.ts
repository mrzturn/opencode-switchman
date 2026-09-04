// Session-style config command templates (injected via cfg.command): /poolConfig-chat and /modelRank-chat
// (the manual interactive dialogs are the TUI plugin's /poolConfig //modelRank; the two complement each other).
// [2026-09-04]-[English localization: translate protocol assets; no semantic change]
// [2026-09-03]-[opencode command `!` blocks execute non-interactively (stdin=ignore/output captured); the interactive dialogs are
//  carried by the TUI plugin (src/tui.tsx DialogSelect); this template is the session-style equivalent flow for non-TUI clients
//  and in-session use: the command injects the current config listing → the user replies with selection/ranking intent → the
//  agent calls switchman-config.js to persist]
import { paths } from "./state"

const q = (p: string): string => JSON.stringify(p)

export function poolConfigCommandMd(cliPath: string): string {
  const cli = q(cliPath)
  const run = (args: string): string => `!\`node ${cli} ${args} 2>/dev/null || bun ${cli} ${args}\``
  return [
    "---",
    "description: interactively configure which models join each task pool (economy/mechanical/main/hard/vision/review); manual task-pool selection takes precedence over system defaults",
    "---",
    "",
    run("pool list"),
    "",
    "The above is an overview of task-pool selection for the six pools (selection = the models joining that task pool, so each pool's candidates show differentiation; one model may join multiple pools; unconfigured pools fall back to system-default decisions). Please:",
    "1. Ask the user which task pool to configure (one of economy/mechanical/main/hard/vision/review); run `pool list <task-pool>` when a full numbered listing is needed.",
    "2. The user expresses selection/deselection with numbers or model names (e.g. \"main keep only 2 5\", \"economy add 1 3, remove 4\", \"clear to restore defaults\"); you translate that into the corresponding commands:",
    `   - Join (select): ${run("pool add <task-pool> <number-or-modelId...>")}`,
    `   - Leave (deselect): ${run("pool remove <task-pool> <number-or-modelId...>")}`,
    `   - Replace all: ${run("pool set <task-pool> <number-or-modelId...>")}`,
    `   - Clear config (the pool returns to the system default candidate set): ${run("pool clear <task-pool>")}`,
    "3. After executing, run `pool list <task-pool>` once more to verify, and report the change and when it takes effect (immediate) in one sentence.",
    "Note: `#number` is only valid against the most recent list output; if the config/available set may have changed between two operations, re-run list before converting numbers.",
    "",
    `Config file: ${paths().poolConfig} (keys = task-pool names, values = arrays of modelIds joining that pool; one model may appear in multiple pools; safe to hand-edit, hot-reloaded on save).`,
    "",
  ].join("\n")
}

export function modelRankCommandMd(cliPath: string): string {
  const cli = q(cliPath)
  const run = (args: string): string => `!\`node ${cli} ${args} 2>/dev/null || bun ${cli} ${args}\``
  return [
    "---",
    "description: interactively configure the model capability ranking (manual ranking takes precedence over base capability scores; the higher, the stronger)",
    "---",
    "",
    run("rank list"),
    "",
    "The first section above is the manual capability ranking (#1 strongest; hit models take their capability score/lane from it), the second is a reference ordering of the currently available models. Please:",
    "1. Ask the user to state the adjustment intent (e.g. \"move glm-5.3 to the very front\", \"swap kimi-k3 and glm-5.2\", \"remove deepseek-v4-pro\", \"clear the ranking\").",
    "2. Translate that into the corresponding commands (numbers reference the global indices across both sections):",
    `   - Full reorder (in the given order): ${run("rank set <number-or-modelId...>")}`,
    `   - Append to the end of the ranking (weakest end): ${run("rank add <number-or-modelId...>")}`,
    `   - Remove from the ranking: ${run("rank remove <number-or-modelId...>")}`,
    `   - Clear (all fall back to base capability scores): ${run("rank clear")}`,
    "3. After executing, run `rank list` once more to verify, and report the new ranking and when it takes effect (immediate) in one sentence.",
    "Note: `#number` is only valid against the most recent list output; if the ranking may have changed between two operations, re-run list before converting numbers.",
    "",
    `Config file: ${paths().capabilityRank} (safe to hand-edit; models array order = capability descending, hot-reloaded on save).`,
    "",
  ].join("\n")
}
