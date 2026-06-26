# Demo project — `acme-api`

A worked example: the canonical `.harness/` for a hypothetical TypeScript REST API.
Only the source is committed; the per-tool config is generated.

What's here:
- `.harness/AGENTS.md` — instructions (with a `harness:redundant` block the optimizer compresses away)
- `.harness/mcp.toml` — two MCP servers (a stdio one and an HTTP one) → transpiled six ways
- `.harness/permissions.toml`, `.harness/enforce.toml` — permissions + a deny rule and a lint-on-edit `run` rule
- `.harness/agents/`, `.harness/commands/`, `.harness/skills/`, `.harness/output-styles/`
- `eval/` — a tiny held-out search/test split so `optimize` runs immediately

## Try it (from the repo root, after `npm run build`)

```bash
node dist/cli.js -C examples/demo-project apply      # generate config for all 7 tools
node dist/cli.js -C examples/demo-project verify     # drift + staleness + enforcement audit
node dist/cli.js -C examples/demo-project optimize   # 297 → 175 context tokens at 100% pass-rate
```

The generated files (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.codex/config.toml`,
`opencode.json`, `.kilocode/mcp.json`, `.pi/extensions/`, …) are gitignored — run
`apply` to see them.
