<!-- [2026-09-04]-[re purpose: dev-only guide for this repo; production dispatcher protocol now lives solely in src/assets/agents-md.ts (English-only), no longer synced from this file] -->
# AGENTS.md — opencode-switchman Development Guide (dev-only, not shipped)

> This file guides development of the opencode-switchman plugin itself. It is NOT the dispatcher protocol and is NOT bundled or injected in production. The production protocol's single source of truth is `src/assets/agents-md.ts` (English-only); do not recreate or sync it here.

## 0. Iron Rules
1. Do it right the first time: confirm goals, boundaries, and acceptance criteria before acting; when unsure, clarify first or explicitly state assumptions.
2. Minimal necessity: read only necessary files and sections, run only necessary commands; conclusions first, cite with file:line.
3. Report honestly: call failure a failure, call a skip a skip, mark uncertainty as uncertain.
4. Annotate changes: comment key changes with `[yyyy-mm-dd]-[why]-[impact]`; skip for self-evident changes.
5. English only: all code, identifiers, comments, bundled assets, commit messages, and generated files in this repo are written in English (translated docs may add localized variants, e.g. README.zh.md).

## 1. Commands
- `bun test` — full behavioral contract baseline; must be all green before finishing any change.
- `bun run typecheck` — `tsc --noEmit`; must pass.
- `bun run gen:shells` — regenerate the shell matrix from `scripts/gen-shells.ts` after touching shell/pool definitions.
- `bun run build` — rebuild `dist/` (runs gen:shells + gen-version first).
- `bun run mode:local` / `mode:prod` — switch the installed plugin between local build and published version.

## 2. Code Map
- `src/index.ts` — plugin entry: config load, system-prompt injection (protocol/banner/watermark), dispatch gates, event wiring.
- `src/assets/agents-md.ts` — bundled dispatcher protocol (production source of truth; `{{DELEGATION_FLOOR}}/{{SOFT}}/{{HARD}}/{{FORCE}}` interpolated at inject time).
- `src/assets/delegation-template.ts` — delegation template written to the state directory at startup.
- `src/shells.ts` — shell definitions and embedded subagent rules.
- `skills/` — bundled agent skills, materialized into the opencode global skills dir (`<configDir>/opencode/skills`) at plugin startup.
- `src/skill-sync.ts` — bundled-skill sync logic (add/overwrite-only copy, marker-gated cleanup, fail-open).
- `src/workspace.ts` — artifact workspace: per-main-session `<project>/.switchman/<yyyy-mm-dd>/<sessionId>-<title>/` folders (SESSION.md / dispatches.jsonl / media/; config `workspace.*`).
- `src/provider-config.ts`, `src/types.ts` — provider/model metadata, routing config, option types.
- `src/lang-config.ts` — project language preference (settings.json + AGENTS.md marker, ask directive, [LANG] line, question capture).
- `scripts/` — codegen (`gen-shells`, `gen-capability-default`, `gen-version`), build helpers, mode switcher.
- `test/` — bun test suites; treat as the behavioral contract (update together with behavior changes).

## 3. Conventions
- Edits to the injected protocol: modify `src/assets/agents-md.ts` directly; keep it English-only and keep placeholders intact.
- Injection dedup: `src/index.ts` skips protocol injection when the user's own AGENTS.md already carries the protocol marker — keep the marker string `# Global Protocol (master dispatcher rules` in sync with the asset.
- Never hand-edit generated files or `dist/`; regenerate via scripts.
- State directory at runtime: `~/.config/opencode/opencode-switchman/`.
