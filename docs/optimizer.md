# The optimizer

`harness optimize` is the [Meta-Harness paper](https://arxiv.org/abs/2603.28052)
applied to a project's config surface, made offline-friendly. This is the half no
other cross-tool config tool ships.

## The idea

The harness — your instructions, commands, subagents, hooks, MCP — is a
performance lever, and tuning it is usually manual. The paper automates it with an
**agentic proposer** that reads a filesystem store of prior variants (source +
scores + **raw execution traces**) and proposes the next edit, scored against a
held-out eval set on a Pareto frontier. The decisive finding: the store of raw
traces is the asset, *not* the search algorithm — and summarizing traces measurably
hurts (50.0 vs 34.9 in their ablation). So we store traces raw and let the proposer
read them on demand.

## The loop

```
for each iteration:
  snapshot parent harness → history/<id>/harness/
  proposer edits the candidate (reads history/ for diagnosis)
  interface-validate the candidate            ← cheap gate before expensive eval
  leakage / overfitting audit                 ← code-space is inspectable
  evaluate on the SEARCH set → scores + raw traces
  record snapshot + scores.json + traces/ + diagnosis.md
  update the Pareto frontier
report frontier; evaluate the best on the HELD-OUT TEST set (proposer never saw it)
```

The outer loop is intentionally thin: no parent-selection heuristics, no bespoke
mutation operators. The proposer self-directs.

## The store — `history/<id>/`

```
history/v01/
  harness/        # full snapshot of the .harness/ that produced this run
  scores.json     # { pass_rate, context_tokens, wall_clock_s, usd, valid, hash, ... }
  traces/<task>.log   # RAW command transcripts — never summarized
  diagnosis.md    # the proposer's hypothesis + root-cause, persisted as data
```

Gitignored by default (`.harness/history/`) — raw traces can be large or sensitive.
Commit it deliberately if you want a shared, compounding experience store.

## Eval tasks

A task is a directory under `optimizer.search_set` (and `test_set`) with a
`task.toml`:

```toml
cmd = 'grep -q "npm run build" "$HARNESS_DIR/AGENTS.md"'
expect_exit = 0
expect_stdout_contains = "optional substring"
```

`HARNESS_DIR` is set to the **candidate's** `.harness/`, so tasks assert against the
variant under evaluation. In offline mode these are deterministic checks (a
stand-in for agent task execution); `context_tokens` is estimated from instruction
size (chars/4) so the optimizer can pursue "equal pass-rate at fewer tokens"
honestly, without a model in the loop. With a real proposer you'd point tasks at
real agent runs (tests pass / build / assertions).

## Proposers

- **`simulated`** (default): a deterministic, token-free editor. It compresses
  redundant context (removes a `harness:redundant` block, collapses whitespace)
  while the search set guards required content — a faithful analog of the paper's
  token-reduction result. Idempotent, so the loop converges.
- **A shell command** (e.g. `claude -p`): the real agentic proposer. We write a
  minimal steering prompt and run it in the candidate's `.harness/`, then detect
  changes by hashing. This is opt-in (`--proposer "claude -p"`) because it spends
  tokens.

The proposer is pinned strong by default and left configurable, because proposer
strength is the dominant uncontrolled variable (the paper only validated one).

## Multi-objective (Pareto)

Objectives default to `pass_rate` (max), `context_tokens` (min), `wall_clock_s`
(min), `usd` (min). The report shows the non-dominated frontier; you pick the
operating point. The common, sellable win is *equal task success at lower
token/cost*.

## Guardrails

- **Interface-validation gate** before any eval — a candidate that doesn't parse is
  stored with its error and skipped, never executed.
- **Held-out split** — `test_set` is never shown to the proposer; `optimize` warns
  loudly if `search_set == test_set`.
- **Leakage audit** every iteration — flags a candidate whose instructions hard-code
  a search-task id (gaming the eval), keeping it off the reported frontier.
- **Human-auditable** — a config diff and the proposer's diagnosis accompany every
  iteration. Code-space changes are readable, unlike weights.

## Adopting a result

```bash
harness optimize --apply     # copy the best variant back into .harness/, then run `harness apply`
```

Or copy by hand from `.harness/history/<id>/harness/`.
