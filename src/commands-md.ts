// Session-style config command templates (injected via cfg.command): /poolConfig-chat and /modelRank-chat
// (the manual interactive dialogs are the TUI plugin's /poolConfig //modelRank; the two complement each other).
// [2026-09-04]-[English localization: translate protocol assets; no semantic change]
// [2026-09-03]-[opencode command `!` blocks execute non-interactively (stdin=ignore/output captured); the interactive dialogs are
// carried by the TUI plugin (src/tui.tsx DialogSelect); this template is the session-style equivalent flow for non-TUI clients
// and in-session use: the command injects the current config listing → the user replies with selection/ranking intent → the
// agent calls switchman-config.js to persist]
// [2026-09-05]-[/expert expert consultation: no CLI round-trip — selection follows the live [ROUTES] banner chain
// (review head preferred; hard head's -ro face as fallback), dispatch goes through the standard six gates + auto-redirect]
import { paths } from "./state"
import { LANG_SETTINGS_FILE } from "./lang-config"

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

// [2026-09-05]-[/switchman-lang: show/reconfigure the project language preference — reads the settings file fresh via a
//  `!` block; re-ask goes through the same marker-question flow (plugin captures and overwrites, the model never edits
//  the file); reset = delete the file (next session asks again); AGENTS.md marker applies only while the file is absent]
export function langCommandMd(workspaceDirname: string): string {
  const rel = `${workspaceDirname}/${LANG_SETTINGS_FILE}`
  return [
    "---",
    "description: show or reconfigure this project's language preference (conversation / code comments & commit messages / documents)",
    "---",
    "",
    `!\`cat "${rel}" 2>/dev/null || echo "(not configured)"\``,
    "",
    `The file above is this project's language preference (\`lang.conversation\` = replies & reasoning, \`lang.comments\` = code comments AND commit messages, \`lang.docs\` = generated documents). A switchman \`[LANG]\` line enforces it every turn as a project-level iron rule; a user language request applies to a single reply only, then reverts.`,
    "If the user wants to change it: call the question tool ONCE with exactly these three questions (question texts verbatim, marker included — the plugin captures the answers and overwrites the file automatically):",
    `1. question "switchman-lang 1/3: Conversation language for this project (your replies and reasoning)?" — single-choice with the current candidate languages, custom free input allowed`,
    `2. question "switchman-lang 2/3: Language for code comments and commit messages?" — same options`,
    `3. question "switchman-lang 3/3: Language for generated documents (plans, PRD, design docs, reports)?" — same options`,
    "After the tool returns, confirm the saved preferences in one line.",
    `If the user asks to reset: run \`rm "${rel}"\` — the next session will ask again.`,
    `Alternatively the user may hand-edit ${rel}, or add a read-only marker line \`switchman:lang conversation=<..> comments=<..> docs=<..>\` to AGENTS.md (marker applies only while the settings file is absent).`,
    "",
  ].join("\n")
}

// [2026-09-05]-[/expert: user-invoked expert consultation; arguments land in $ARGUMENTS (opencode substitutes them;
// empty/literal $ARGUMENTS → the model asks first). Review head is already an ro shell (review face pool is ro-only);
// the hard head is rw, so the fallback appends -ro to reach the read-only face. source=user both marks the explicit
// user intent and exempts gate-7 cross-level fallback chain checks]-[dispatch passes the standard six gates + auto-redirect]
export function expertCommandMd(): string {
  return [
    "---",
    "description: Dispatch the requirement to the strongest available expert (review pool preferred; hard pool top model on its read-only shell as fallback) for an expert answer or design",
    "---",
    "",
    "The user invoked /expert. Their requirement (verbatim; may be empty):",
    "$ARGUMENTS",
    "",
    "If the requirement is empty or still shows the literal $ARGUMENTS, ask the user what to consult the expert about and continue with the reply.",
    "",
    "Execute exactly ONE delegation. Declare `[DISPATCH] delegate <shell>: /expert consultation` first, then:",
    "",
    "1. Read the `[ROUTES]` line in your system prompt banner. Names there are short forms — restore full shell names by inserting `-mx-` after the pool prefix (`ds-` prefix = deepseek pool); full names are in your task tool's shell list.",
    "2. Preferred — review pool expert: if the `review:` segment lists shell names, take its head (prefer a candidate of a different model family than yours when available) and delegate with the prompt head (fill in your REAL model family):",
    '   ROUTE_META {"lane":"review","role":"expert-alpha","producer_family":"<your-real-model-family>","capability":"ro","modality":"text","source":"user"}',
    "3. Fallback — only when the `review:` segment shows `all unavailable→terminal failure protocol` (or the review dispatch is denied with the chain exhausted): take the head of the `hard:` chain and delegate to its read-only face — the same full shell name with `-ro` appended (skip if it already ends in `-ro`) — and declare `DOWNGRADED: review pool unavailable, hard-pool expert on its ro shell`. Prompt head:",
    '   ROUTE_META {"lane":"hard","role":"planner","producer_family":"<your-real-model-family>","capability":"ro","modality":"text","source":"user"}',
    "4. Delegation prompt body (self-contained): verbatim user requirement; known facts/conclusions and relevant file paths from this session; project-level constraints; output format = expert answer or design — conclusion first, then rationale, alternatives, risks, acceptance criteria, file:line evidence. Read-only consultation: no code changes.",
    "5. Relay the expert's full conclusions to the user and end with one line naming the shell and lane used, e.g. `expert: <shell> (review)` / `<shell> (hard·ro, DOWNGRADED)`.",
    "6. If a dispatch is denied, redirect to the first candidate named in the deny postscript (the plugin auto-redirects by default). If both pools are unavailable, follow the terminal failure protocol: explain the reason and offer 2 options.",
    "",
  ].join("\n")
}
