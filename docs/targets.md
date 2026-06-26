# Targets

What each adapter emits, where, and how it degrades. Run `harness list-targets`
for the live capability matrix. Legend: ● native · ◐ shim/bridge · ⚙ code-gen · · unsupported.

## Claude Code — `src/targets/claude-code.ts`

The richest target. Claude Code reads `CLAUDE.md`, **not** `AGENTS.md`, and has no
fallback — so we emit `AGENTS.md` (the canonical text) plus a generated `CLAUDE.md`
containing a single `@AGENTS.md` import (Windows-safe; never a symlink-only shim).

| Output | From |
|--------|------|
| `AGENTS.md`, `CLAUDE.md` | instructions |
| `.claude/skills/<n>/SKILL.md` | skills |
| `.claude/agents/<n>.md` | agents |
| `.claude/commands/<n>.md` | commands |
| `.claude/output-styles/<n>.md` | output-styles |
| `.mcp.json` | mcp (project-scoped) |
| `.claude/settings.json` | permissions + **compiled enforcement** (hooks + deny) |

This is the only target with a real deterministic enforcement layer. `enforce.toml`
`deny` rules become `permissions.deny` entries; `warn`/`run` become hooks on the
mapped lifecycle event.

## Codex (CLI + Desktop) — `src/targets/codex.ts`

One adapter covers both surfaces — they share `~/.codex`. Reads `AGENTS.md`
natively. Machine config goes to a project `.codex/config.toml` (approval/sandbox
+ `[mcp_servers.*]`), which **only loads for trusted projects** — the file
includes the `projects."<path>".trust_level = "trusted"` snippet you need.

Codex expresses permissions as `approval_policy` + `sandbox_mode`, not per-tool
patterns — tool rules are reported as mapped-to-defaults. No subagents, no output
styles, no project-scoped commands (those degrade to warnings).

## OpenCode — `src/targets/opencode.ts`

Reads `AGENTS.md` natively. Agents/commands are markdown under `.opencode/`. MCP +
permissions live in one `opencode.json` — note its MCP shape is the ecosystem's
biggest divergence: `command` is a single merged array, the field is `environment`
(not `env`), and there's an `enabled` flag with `type: local|remote`.

## Cline — `src/targets/cline.ts`

Reads `AGENTS.md` + `.clinerules/`. Commands → `.clinerules/workflows/*.md`.
`.clineignore` is generated from `Read` deny patterns. MCP lives in VS Code
globalStorage, which we **can't safely write**, so it's emitted to
`.harness/.generated/cline/cline_mcp_settings.json` with a placement note. No
subagents (Plan/Act only), no hook layer.

## Kilo Code — `src/targets/kilo.ts`

A Roo + Cline superset. `AGENTS.md` must be **UPPERCASE** (our canonical path
already is). Commands → `.kilocode/workflows/`, subagents → `.kilo/agents/`. Unlike
Cline, MCP is a project file (`.kilocode/mcp.json`, Roo-style with
`disabled`+`alwaysAllow`), so it's written directly.

## Pi — `src/targets/pi.ts`

The `pi.dev` coding agent. Reads **both** `AGENTS.md` and `CLAUDE.md` natively, so
instructions need no translation. Its core is deliberately minimal:

- **Skills** → the shared `.agents/skills/` location Pi reads alongside other
  Agent-Skills tools (write once, picked up everywhere).
- **MCP** → a generated `.pi/extensions/mcp-servers.ts` (Pi has no MCP config key).
  The extension marks a clear integration seam — verify the registration hook
  against current pi.dev docs, since Pi moves fast.
- **Commands** → `.pi/prompts/`. **Permissions** → coarse `defaultProjectTrust`.
- Subagents/hooks are extension-only (degraded to warnings).

## How "global-only" config is handled

Some config is genuinely user-global, not project-scoped (Cline's globalStorage
MCP, Codex/Pi user settings). Rather than write into a user's home directory or VS
Code internals, the adapter emits a project-local reference file under
`.harness/.generated/` with a `note` telling you exactly where to place it. Nothing
outside the project root is touched.
