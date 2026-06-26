# Meta-Harness Studio

**Author your AI coding harness once. Project it onto every tool. Then let it improve itself from execution traces.**

One canonical `.harness/` becomes correct, native config for **Claude Code, Codex (CLI + Desktop), OpenCode, Cline, Kilo Code, and Pi** — not just instructions, but commands, subagents, hooks, MCP servers, and permissions. Then `harness optimize` closes the loop the way the [Meta-Harness paper](https://arxiv.org/abs/2603.28052) describes: a swappable agentic proposer reads a store of raw execution traces and proposes harness edits, scored on a Pareto frontier.

```
.harness/  ──►  CLAUDE.md · AGENTS.md · .mcp.json · config.toml · opencode.json
                .clinerules/ · .kilocode/mcp.json · .pi/extensions/ · hooks · skills · …
```

---

## Why this exists

Every coding agent reinvents the same config: `CLAUDE.md` here, `AGENTS.md` there, `config.toml`, `.clinerules/`, four different MCP formats, per-tool hooks. Keeping them consistent by hand rots fast — instructions drift out of sync with the scripts they reference (**"rule drift"**: a `CLAUDE.md` that still says `npm run check` after the script was renamed), and no tool checks.

Tools like **Ruler** and **rulesync** solve half of this: they're one-way compilers that fan a single source of truth out to N tools. But, as the most-upvoted critique of that whole category puts it, *"compilation enforces consistency, not behavior."* Synced rules don't make an agent comply, and **execution outcomes never flow back** to improve the rules.

Meta-Harness Studio does both halves:

1. **Project everywhere, correctly** — including the parts sync tools skip: generated **enforcement** (hooks + permission denies), the five genuinely-different **MCP serializations** (six tools — Cline and Kilo share the Roo-lineage shape), and graceful degradation when a tool can't express a feature.
2. **Close the loop** — ingest execution feedback, let an agentic proposer diagnose from **raw traces** and edit the harness, validate, and report a Pareto frontier. No other cross-tool config tool does this.

---

## Quickstart

```bash
# from this repo
npm install && npm run build
node dist/cli.js --help          # or `npm link` to get a global `harness`

# in any project
harness init          # scaffold .harness/ (imports an existing AGENTS.md/CLAUDE.md if present)
harness author        # OR: scan the repo and auto-author a working .harness/ (deterministic)
harness apply         # generate native config for every enabled tool
harness verify        # audit drift + stale references + enforcement coverage
harness optimize      # close the loop (simulated proposer — no tokens, no model)
```

`harness init` ships a tiny eval set, so `optimize` runs end-to-end immediately:

```text
Optimizing "acme-api" — proposer=simulated, 3 search task(s), ≤3 iteration(s)
  v00 baseline   pass 100%  ctx    297 tok  0.0157s
  v01 candidate  pass 100%  ctx    175 tok  0.0137s
  v02 converged — proposer found no further improvement.

Result
✔ Best variant v01: context_tokens 297 → 175 (−122 tok), pass_rate 100% → 100% (+0 pts).
  held-out test set: pass 100% (baseline 100%) on 1 task(s) the proposer never saw.
```

That's the paper's headline outcome — **equal pass-rate at fewer tokens** — reproduced offline.

See [`examples/demo-project/`](examples/demo-project/) for a complete worked example — MCP servers, a subagent, an output style, and an enforce rule. Run `harness -C examples/demo-project apply` to generate native config for all 6 tools (generated files are gitignored, so you produce them yourself).

---

## The canonical spec — `.harness/`

```
.harness/
  harness.toml            # which targets, projection policy, optimizer config
  AGENTS.md               # canonical instructions — the portable backbone (5 of 6 tools read it natively)
  instructions/**/AGENTS.md  # optional nested per-package (monorepo nearest-wins)
  mcp.toml                # canonical MCP servers (one schema → 6 serializers)
  permissions.toml        # allow / deny / ask + sandbox intent (degrades per tool)
  enforce.toml            # "must-happen" rules → hooks + permission denies (Claude Code) / advisory elsewhere
  skills/<name>/SKILL.md  # Agent-Skills standard
  agents/<name>.md        # subagent specs
  commands/<name>.md      # slash commands / prompt templates
  output-styles/<name>.md # emitted where supported (Claude today)
  history/                # the optimizer's experience store (raw traces) — gitignored by default
```

Instructions live in **AGENTS.md** because it's the de-facto standard 5 of the 6 targets read natively (Claude Code imports it via a generated `CLAUDE.md` → `@AGENTS.md` shim). Machine config is **TOML** (Codex's native format, and it transpiles cleanly down to JSON). We don't invent an instruction format — only four small TOML files are net-new.

---

## Supported tools

| Tool | Instructions | MCP | Notes |
|------|--------------|-----|-------|
| **Claude Code** | `CLAUDE.md` + `@AGENTS.md` import shim | `.mcp.json` | Richest target: real hooks + permission enforcement |
| **Codex** (CLI + Desktop) | `AGENTS.md` (native) | `config.toml` `[mcp_servers]` | Shared `~/.codex`; project config needs trust |
| **OpenCode** | `AGENTS.md` (native) | `opencode.json` (command-as-array) | Biggest MCP divergence — handled |
| **Cline** | `AGENTS.md` + `.clinerules/` | globalStorage (emitted as reference) | Commands → workflows; no subagents |
| **Kilo Code** | `AGENTS.md` (UPPERCASE) | `.kilocode/mcp.json` | Roo+Cline lineage |
| **Pi** | `AGENTS.md` **and** `CLAUDE.md` | generated TS extension | Minimalist core; MCP is code-gen |

Run `harness list-targets` for the full capability matrix, and `harness doctor` to see which agent CLIs are installed.

> **Adding/removing a target is one edit** to `src/targets/registry.ts`. Targets churn fast (Gemini CLI was retired mid-2026; Kilo/Antigravity forked into IDE+CLI), so the adapter list is data-driven, not hard-wired into the engine.

---

## MCP: one definition, five shapes

MCP is the one capability with no shared format. A single canonical server in `mcp.toml`:

```toml
[servers.github]
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }   # ${ENV} refs only — never literal secrets
```

is transpiled to each tool's real shape — Claude/Cline/Kilo JSON (`mcpServers`, but Cline/Kilo add `disabled`+`alwaysAllow`), Codex TOML (`bearer_token_env_var` for HTTP), OpenCode's array-merged `command` + `environment` + `enabled`, and a **generated TypeScript extension for Pi** (which has no MCP config key). These can't be symlinked — only transpiled.

---

## The optimizer

Faithful to the [paper](https://arxiv.org/abs/2603.28052), made offline-friendly. A thin outer loop, a fat proposer:

```
snapshot → proposer edits → interface-validate → leakage audit → evaluate → record → Pareto
```

- **The store is the asset, not the algorithm.** Every variant keeps its harness snapshot, scores, **raw execution traces**, and a written diagnosis under `history/<id>/`. The paper's decisive ablation showed raw traces beat summaries (50.0 vs 34.9), so traces are **never pre-summarized** — the proposer greps them on demand.
- **Swappable proposer.** Default is a deterministic, **token-free simulated proposer** (compresses redundant context while a held-out search set guards required content). Pass `--proposer "claude -p"` for the real agentic proposer.
- **Multi-objective.** Pareto frontier over `pass_rate × context_tokens × wall_clock × usd` — you pick the operating point.
- **Guardrails.** Interface-validation gate before any eval; held-out test split the proposer never sees; a leakage/overfitting audit each iteration (code-space is inspectable — we make that a feature); human-auditable config diff per iteration.

```bash
harness optimize                       # simulated, clears history/
harness optimize --apply               # adopt the best variant into .harness/

# Real agentic proposer. Headless coding agents are sandboxed, so grant write +
# read of the sibling history/ store — otherwise the proposer can only diagnose
# and no edits persist (it converges to a no-op):
harness optimize --proposer "claude -p --dangerously-skip-permissions --add-dir ../.." --iterations 5
```

Define eval tasks as directories under `eval/search/` and `eval/test/`, each with a `task.toml`:

```toml
cmd = 'grep -q "npm run build" "$HARNESS_DIR/AGENTS.md"'
expect_exit = 0
```

`HARNESS_DIR` points at the candidate's `.harness/`, so tasks assert against the *candidate* — e.g. "the build command is still documented," which stops the optimizer compressing away essential context.

---

## Commands

| Command | What it does |
|---------|--------------|
| `harness init [--yes]` | Scaffold `.harness/`; import an existing `AGENTS.md`/`CLAUDE.md`/`.cursorrules` |
| `harness author [--force] [--proposer <cmd>] [--optimize]` | Scan the repo and auto-author a working `.harness/` (deterministic; `init --from-repo` is an alias). `--proposer "claude -p"` adds an opt-in LLM pass (validate-or-revert); `--optimize` chains the loop |
| `harness apply [--dry-run]` | Validate → project the canonical spec onto every enabled tool |
| `harness verify` | Audit drift, stale script references, and enforcement coverage (CI-friendly exit code) |
| `harness optimize [--proposer <cmd>] [--iterations <n>] [--apply]` | Close the loop |
| `harness list-targets` | Capability matrix across all targets |
| `harness doctor` | Node version + which agent CLIs are installed |

Global: `-C, --cwd <dir>` to run against another directory, `-q, --quiet`.

---

## What makes it different (vs Ruler / rulesync / ai-rules)

Those tools nail the commoditized half — centralize rules, fan out to N tools. Meta-Harness Studio matches that and adds the four things none of them do:

1. **Closed execution-feedback loop** — a raw-trace-driven proposer evolves the harness.
2. **Compiled enforcement** — `enforce.toml` becomes real Claude Code hooks + permission denies, not just prose.
3. **Compliance & coverage reporting** — `verify` tells you which invariants are deterministically enforced vs advisory, per tool.
4. **Semantic drift detection** — referenced scripts are checked against `package.json`, not just byte-compared.

---

## Design principles

- **Don't fight the standard.** AGENTS.md is the backbone; plain rule-sync is already commoditized.
- **Interface, not algorithm.** The optimizer manages a filesystem store and shells out to a strong coding agent. There's no bespoke search engine to maintain.
- **Honest degradation.** When a tool can't express a feature (Codex has no output styles; Pi has no MCP config key), we say so in a warning instead of emitting something that silently does nothing.
- **Generate only what's declared.** Output styles only where supported, Pi MCP code-gen only when a server exists, hooks only from real `enforce.toml` invariants.

---

## Roadmap (deliberately out of scope for v1)

- Live/online optimization service (offline batch only today).
- More targets (Cursor, Copilot, Windsurf) — a registry entry each.
- Co-evolving model weights (the paper's future work).

---

## Credits

The optimizer is grounded in **"Meta-Harness: End-to-End Optimization of Model Harnesses"** (Lee, Nair, Zhang, Lee, Khattab, Finn — [arXiv:2603.28052](https://arxiv.org/abs/2603.28052)). The instruction backbone builds on [AGENTS.md](https://agents.md/).

MIT © 2026 Pragnesh ([@fugitivexyz](https://github.com/fugitivexyz))
