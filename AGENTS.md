# meta-harness-studio

Canonical, tool-agnostic instructions for any AI coding agent in this repo. Single
source of truth — `harness apply` projects this to Claude Code, Codex, OpenCode, and Pi.

## Commands
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (vitest)
- Typecheck: `npm run typecheck`
- Run the CLI from source: `npm run harness -- <command>` (e.g. `npm run harness -- apply`)

## Conventions
- Keep changes minimal and surgical; match the existing style.
- Never commit secrets. MCP env values are `${ENV}` references only, never literals.
- Never hand-edit `dist/` — it is `tsc` output. Edit `src/` and rebuild.
- Validate-first: the zod schemas in `src/config/schema.ts` are the interface gate;
  a candidate that doesn't parse is rejected before any projection or eval runs.

## Architecture (load-bearing facts)
- Adapters are data-driven. Adding or removing a target is one edit to
  `src/targets/registry.ts` — the engine never hard-wires a tool.
- The optimizer's asset is its store, not its algorithm. Each variant keeps its raw
  execution traces plus a written diagnosis under `.harness/history/<id>/`. Store
  raw traces and never summarize them (the paper's ablation: 50.0 vs 34.9).
- MCP is the one capability with no shared format: five genuinely-different
  serializations across six tools. It is transpiled per target, never symlinked.
- Enforcement (`enforce.toml`) compiles to real Claude Code hooks + permission
  denies; everywhere else it degrades to advisory notes.

## Gotchas — verified, do NOT "fix"
- Kilo subagents live at `.kilo/agents/`. This is correct, not a typo: `.kilocode/`
  holds mcp + rules, `.kilo/` holds agents (verified against kilo.ai docs, 2026-06).
- Adapter format details (OpenCode permission vocab, Codex project skills, the
  SSE-vs-HTTP MCP split) are deliberate research. Verify against current tool docs
  before changing them.

<!-- harness:redundant -->
## Background notes (non-load-bearing)
This section restates narrative context that is pleasant to read but costs context
tokens without changing what an agent must do. Meta-Harness Studio is a TypeScript
CLI that authors one `.harness/` and projects it onto several coding agents, then
closes a self-improvement loop grounded in the Meta-Harness paper. The README
already covers the motivation, the contrast with one-way rule-sync tools, and the
full command surface in depth, so re-deriving all of that here is pure redundancy.
`harness optimize` compresses this block away while the eval set guarantees every
load-bearing fact above survives untouched.
<!-- /harness:redundant -->
