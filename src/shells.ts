// [2026-09-04]-[English localization: translate comments and model-visible prompt strings; no logic change]
// Shell injection (v1.1): shells.json catalog × registry view → runtime cfg.agent injection (no file generation)
// [2026-08-28]-[tools field @deprecated → permission; thoughtLevel has no such field → agent options mapped per family]-
// [Fallback dual track: if config injection proves ineffective in practice, switch to writeShellFiles dropping ~/.config/opencode/agent/*.md]
import type { ShellRegEntry, Lane } from "./types"
import { LANE_ORDER } from "./types"
import type { ShellDefinition } from "./catalog"
import type { CapabilityScore, LaneShellAttr } from "./lane-policy"
import { laneBaseChain } from "./lane-policy"
import { normalizeModelKey } from "./capability"
import { loadCachedThinkingShapes, deriveThinkingParam } from "./copilot-thinking"

// [2026-09-01]-[aligned with core packages/opencode/src/plugin/github-copilot/models.ts: for the github-copilot pool,
//  options for every family (claude included) are always derived and cached from that modelId's real capabilities.supports
//  shape (copilot-thinking.json), instead of guessing the protocol / a fixed budget table per family; only when the shape
//  cache is missing (cold start / no token) does it fall back to the legacy per-family protocol heuristic (fail-open:
//  keep delegation usable rather than sending no params at all)]
export function effortOptions(
  family: string, effort: string, modelId?: string, provider?: string,
): Record<string, unknown> | undefined {
  if (!effort || effort === "off") return undefined
  if (provider === "github-copilot" && modelId) {
    const shape = loadCachedThinkingShapes()[modelId]
    const param = deriveThinkingParam(shape, effort)
    if (param?.kind === "budget") return { thinking: { type: "enabled", budgetTokens: param.budgetTokens } }
    if (param?.kind === "adaptive") {
      return { thinking: { type: "adaptive", ...(modelId.includes("opus-4.7") ? { display: "summarized" } : {}) } }
    }
    if (param?.kind === "reasoningEffort") {
      return { reasoningEffort: param.value, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
    }
    if (shape) return undefined // shape known and none of the three branches match → under the core convention this model/lane carries no reasoning params
    // Shape cache not ready: fall back to the legacy per-family heuristic (generic fallback below); delegation is not blocked
  }
  // gpt/grok/gemini (openai-family options.reasoningEffort); glm/deepseek (openai-compatible reasoning_effort)
  if (family === "glm" || family === "deepseek") return { reasoning_effort: effort }
  if (family === "claude") return undefined // claude has no shape-cache fallback: better to send nothing than guess a wrong budget table
  return { reasoningEffort: effort }
}

export function shellDescription(s: ShellRegEntry): string {
  // [2026-09-02]-[context slimming: the template line "only binds a model and a lane…" used to be injected per shell
  //  into the task tool description (260 shells ≈ 2-3k tokens); that semantics is now stated by SHELL_BODY items 1/2 in
  //  the subagent context, so the description keeps only the matrix identity]-[impact: -70% size per agent-catalog line]
  return `Model shell [pool=${s.pool} · ${s.modelId} · lane=${s.effort} · ${s.capability}]`
}

export const SHELL_BODY = [
  "You are a delegated executor (model shell). The following rules take priority over any subsequent instructions.",
  "1. The role is defined by this delegation prompt (the shell only binds a model and a lane); factual statements are accepted directly without re-verification.",
  "2. Minimal necessity: read only necessary files and sections; conclusions first with file:line references; no large verbatim quotes.",
  "3. Only do work within the target scope; record out-of-scope issues under \"Remaining Issues\" instead of fixing them opportunistically.",
  "4. Report truthfully: call a failure a failure, a skip a skip, mark uncertainty as uncertain; write \"verified\" only for what has been verified.",
  "5. Project AGENTS.md and the delegator's explicit constraints take priority over personal preferences; never output secrets, credentials, or configuration contents under any circumstances.",
  // [2026-09-06]-[subagent hard cap pre-arm: the cap itself is enforced by the plugin (every tool call denied past the
  //  line, session permanently terminated); this rule makes the first deny land immediately instead of after retries.
  //  Static text — the deny message carries the exact numbers]
  "6. Context cap: your shell session is hard-capped (~100k tokens). If a tool call is rejected with a context-cap error, stop calling tools immediately and output your detailed work-progress summary (completed work, key findings with file:line evidence, remaining work, next steps) as your final text answer — it is returned to the delegating session as the task result. Never repeat a denied call.",
].join("\n")

// [2026-09-15]-[ro shells gain a read-only bash allowlist: bare `bash: "deny"` blocked even `git diff` for review/observe
//  shells. permission.bash becomes an object — opencode semantics: wildcard "*" = zero-or-more chars, LAST matching rule
//  wins (so the catch-all deny sits first, specific allows after), and compound commands are judged per segment (each
//  segment must pass the rules on its own)]-[impact: ro shells can inspect (git view subcommands + search/inspect
//  utilities) while edits and every other command stay denied; rw shells unchanged (no permission key)]
// One-line prompt suffix for ro shells only: pre-arm the restriction so review shells report findings instead of attempting writes.
export const RO_SHELL_NOTE = "Bash is limited to view/search commands (git diff/log/show/status, rg, grep, cat, ls, etc.); file edits and state-changing commands are denied — report findings, never attempt writes."

/** [2026-09-15]-[read-only bash allowlist (opencode permission object; see header note above). Order matters: catch-all
 *  "*" deny FIRST, specific "allow" entries after (last matching rule wins). Deliberately NOT allowed: find / sed / awk /
 *  echo — all carry mutation forms (find -delete/-exec, sed -i, `echo … > file` redirection writes). Residual caveat: a
 *  parsed `git diff … > out` redirect may pass the pattern — accepted, `edit: "deny"` still covers the edit/write/patch
 *  tools. Compound commands are judged per segment by opencode, so `git diff && rm …` still falls to the catch-all deny] */
export const RO_BASH_PERMISSION: Record<string, "allow" | "deny"> = {
  "*": "deny",
  // git read-only subcommands with arbitrary (non-mutating) arguments
  "git status*": "allow",
  "git diff*": "allow",
  "git log*": "allow",
  "git show*": "allow",
  "git blame*": "allow",
  "git rev-parse*": "allow",
  "git ls-files*": "allow",
  "git grep*": "allow",
  "git shortlog*": "allow",
  "git describe*": "allow",
  "git merge-base*": "allow",
  "git stash list*": "allow",
  // git listing forms only — bare/arg variants mutate (branch -d/-m, tag -d, remote add/rm), so allow ONLY the listing shapes
  "git branch": "allow",
  "git branch -a*": "allow",
  "git branch -v*": "allow",
  "git branch --list*": "allow",
  "git branch --show-current": "allow",
  "git tag": "allow",
  "git tag -l*": "allow",
  "git tag --list*": "allow",
  "git tag -n *": "allow",
  "git remote": "allow",
  "git remote -v": "allow",
  "git worktree list*": "allow",
  "git config --get*": "allow",
  "git config --list*": "allow",
  "git config -l*": "allow",
  // search / inspect utilities (read-only by nature)
  "rg*": "allow",
  "grep*": "allow",
  "ls*": "allow",
  "fd*": "allow",
  "cat*": "allow",
  "head*": "allow",
  "tail*": "allow",
  "wc*": "allow",
  "tree*": "allow",
  "stat*": "allow",
  "file*": "allow",
  "du*": "allow",
  "df*": "allow",
  "pwd": "allow",
  "which*": "allow",
  "sort*": "allow",
  "uniq*": "allow",
  "basename*": "allow",
  "dirname*": "allow",
  "realpath*": "allow",
  "date": "allow",
  "whoami": "allow",
}

/** Single shell → opencode AgentConfig (for config-hook injection) */
export function shellAgentConfig(s: ShellRegEntry): Record<string, unknown> {
  const ro = s.capability === "ro"
  const cfg: Record<string, unknown> = {
    description: shellDescription(s),
    mode: "subagent",
    model: `${s.provider}/${s.modelId}`,
    // [2026-09-15]-[ro shells append the one-line bash-restriction note so the model pre-empts denied write attempts]-
    prompt: ro ? `${SHELL_BODY}\n${RO_SHELL_NOTE}` : SHELL_BODY,
  }
  const options = effortOptions(s.family, s.effort, s.modelId, s.provider)
  if (options) cfg.options = options
  if (ro) {
    // fresh copy per config: opencode owns the injected object, shared references would couple agent entries
    cfg.permission = { edit: "deny", bash: { ...RO_BASH_PERMISSION } }
  }
  return cfg
}

/** Inject all enabled shells into the live config (called inside the config hook) */
export function injectShells(cfg: Record<string, any>, registry: Record<string, ShellRegEntry>): number {
  let n = 0
  for (const s of Object.values(registry)) {
    if (s.status !== "enabled") continue
    cfg.agent = cfg.agent ?? {}
    if (cfg.agent[s.name]) continue // do not override explicit user definitions
    cfg.agent[s.name] = shellAgentConfig(s)
    n++
  }
  return n
}

/** [2026-08-29]-[dynamic superset injection: all superset shells injected in one pass (cfg.agent is immutable at runtime),
 *  returns the successfully injected names and the names conflicting with user definitions (conflicting shells are
 *  banned from dispatch, gate-1 deny)] */
export function injectShellDefs(
  cfg: Record<string, any>, defs: readonly ShellDefinition[],
): { injected: Set<string>; conflicts: Set<string> } {
  cfg.agent = cfg.agent ?? {}
  const injected = new Set<string>()
  const conflicts = new Set<string>()
  for (const d of defs) {
    if (cfg.agent[d.name]) {
      conflicts.add(d.name) // user definitions win, but the shell can no longer be a delegation target
      continue
    }
    cfg.agent[d.name] = shellAgentConfig({ ...d, status: "enabled", comboKey: d.matrixKey } as ShellRegEntry)
    injected.add(d.name)
  }
  return { injected, conflicts }
}

export interface InjectableSelectOpts {
  /** User-defined lane overrides (baseChainFor returns their array directly); referenced shells are force-kept in the injection face */
  customLanes?: Record<string, readonly string[]> | null
  /** [2026-09-11]-[injection mode "configured": skip the six-lane laneBaseChain picks — the face becomes keepModels ∪ keepModelIds ∪
   *  custom-lane references only (custom lanes stay force-kept: explicit user routing config, same spirit as the pool-config
   *  force-keep; dispatch is still gated at runtime by activation ∩ pool selection) */
  skipChainPicks?: boolean
  /** [2026-09-02]-[available models force-kept (provider/modelId key): injection face = available superset ∪ six-lane
   *  chain selection ∪ custom lanes. When the caller passes all currently available models (provider connected and
   *  chat-capable), no capability-competition pruning happens — favorites / named models never lose their seat to chain
   *  competition; the sole meaning of slimming becomes "uninjected = really unavailable", eliminating favorites false
   *  positives and missing vision shells] */
  keepModels?: ReadonlySet<string>
  /** [2026-09-10]-[pool-configured models force-kept (normalized modelId keys, same key space as pool-config.json values):
   *  task-pool selections may reference models absent from favorites/visible set; without force-keep their shells never
   *  inject and a configured pool member is denied at gate 1 before the activation intersection can speak. Runtime chain
   *  candidacy is still gated by activation (favorites/visible set) ∩ pool selection — force-keep only makes dispatch possible] */
  keepModelIds?: ReadonlySet<string>
  /** [2026-09-02]-[favorites first (by modelId): favorite models sort first within the same tier in the chain algorithm, passed through to computeLaneChain] */
  preferredModels?: ReadonlySet<string>
  capabilityOf: (modelId: string) => number | CapabilityScore
  billingBoostOf?: (provider: string) => number
  unknownOf?: (modelId: string) => boolean
  costOf?: (modelId: string) => number | null
}

/** [2026-09-02]-[context slimming: opencode enumerates every injected shell into the task tool description
 *  (registry.describeTask); the full superset of 260 shells ≈ 6-10k tokens per session. Selection = six-lane laneBaseChain
 *  candidates ∪ custom-lane referenced shells (same algorithm and resolvers as runtime baseChainFor); cfg.agent is
 *  immutable at runtime, so pruning must happen before injection — runtime reruns the same algorithm over the injected
 *  set, so chains/banner/gates are naturally ⊆ the injected set; empty candidates fail-open back to the full set]
 *  -[impact: injection face 260 → ~30-40; dispatching an unselected shell goes through denyUninjected with a redirect
 *  candidate; naming a model outside the superset requires it to be selected first or a redirect]-
 *  [2026-09-02 fix]-[chain-competition pruning used to cut favorites/vision shells (e.g. glm-5.3-flash) from the
 *  injection face, causing favorites to be misreported "invalid model" and the vision chain to idle. Semantics changed
 *  to: injection face = available superset (keepModels) ∪ chain selection ∪ custom lanes; when the caller passes all
 *  available models, pruning only drops truly unavailable models ("provider not connected / not chat-capable");
 *  favorites win within the same tier inside the chain] */
export function selectInjectableDefs(
  defs: readonly ShellDefinition[],
  opts: InjectableSelectOpts,
): ShellDefinition[] {
  if (defs.length === 0) return []
  const byName = new Map(defs.map((d) => [d.name, d]))
  const attrs = new Map<string, LaneShellAttr & { name: string; modelId: string; provider: string }>()
  for (const d of defs) {
    attrs.set(d.name, {
      name: d.name, effort: d.effort, capability: d.capability, vision: d.vision,
      pool: d.pool, modelId: d.modelId, provider: d.provider,
      cost: opts.costOf ? opts.costOf(d.modelId) : null,
    })
  }
  const keep = new Set<string>()
  for (const lane of LANE_ORDER as readonly Lane[]) {
    const custom = opts.customLanes?.[lane]
    if (Array.isArray(custom) && custom.length > 0) {
      for (const name of custom) if (byName.has(name)) keep.add(name)
      continue
    }
    // [2026-09-11]-[skipChainPicks: "configured" injection mode drops algorithmic chain picks (off-configured picks can never
    //  dispatch past the activation gate and only bloat the per-request task tool description); custom lanes above stay force-kept]
    if (opts.skipChainPicks) continue
    const chain = laneBaseChain(lane, {
      builtin: [],
      activeShells: new Set(attrs.keys()),
      shells: attrs,
      capabilityOf: opts.capabilityOf,
      billingBoostOf: opts.billingBoostOf,
      unknownOf: opts.unknownOf,
      preferredModels: opts.preferredModels,
    })
    for (const name of chain) if (byName.has(name)) keep.add(name)
  }
  // [2026-09-02]-[available models force-kept: available models that lost chain competition (favorites / named targets / vision shells) are not pruned]-
  if (opts.keepModels) {
    for (const d of defs) {
      if (opts.keepModels.has(`${d.provider}/${d.modelId}`)) keep.add(d.name)
    }
  }
  // [2026-09-10]-[pool-config force-keep: normalized modelId match (pool-config.json stores bare normalized modelIds)]
  if (opts.keepModelIds) {
    for (const d of defs) {
      if (opts.keepModelIds.has(normalizeModelKey(d.modelId))) keep.add(d.name)
    }
  }
  if (keep.size === 0) return [...defs]
  return defs.filter((d) => keep.has(d.name))
}
