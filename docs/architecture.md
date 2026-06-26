# Architecture

Meta-Harness Studio is a single CLI with a small, layered core. Data flows in one
direction for projection, and loops for optimization.

```
.harness/ ──load──► HarnessSpec ──projectAll──► ResolvedOutput[] ──writeOutputs──► tool files
   ▲                    │                                                              │
   │                    └──────────────── optimize loop (propose → eval → record) ◄────┘
   └── history/ (experience store: snapshots + raw traces + scores + diagnoses)
```

## Layers

| Layer | Files | Responsibility |
|-------|-------|----------------|
| **Config** | `src/config/{schema,load,canonical}.ts` | Parse + validate `.harness/` into one typed `HarnessSpec`. Zod schemas are the interface-validation gate. |
| **Targets** | `src/targets/*` | One `Adapter` per tool. `project(spec) → FileOutput[]`. Data-driven registry. |
| **MCP** | `src/mcp/transpile.ts` | Pure serializers: one canonical server → five tool shapes across six tools (Cline + Kilo share the Roo-lineage JSON). |
| **Enforce** | `src/enforce/hooks.ts` | Compile `enforce.toml` invariants into Claude Code hooks + permission denies. |
| **Engine** | `src/engine/{project,write,staleness,manifest,gitignore}.ts` | Run adapters, dedupe, reconcile conflicts, write/diff to disk, prune orphaned outputs, detect stale refs. |
| **Optimize** | `src/optimize/*` | Experience store, evaluator, proposer, Pareto frontier, leakage audit. |
| **Commands** | `src/commands/*` | `init`, `apply`, `verify`, `optimize`, `list-targets`, `doctor`. |

## The canonical model

Everything parses into `HarnessSpec` (`src/config/canonical.ts`). Adapters read
this shape and nothing else — they never touch raw TOML/Markdown. That decoupling
is what lets you add a target without changing the engine, and lets the optimizer
mutate `.harness/` files freely as long as they still parse.

Validation errors are **collected, not thrown** (`LoadResult.errors`). The CLI
shows them all at once; the optimizer stores an invalid candidate with its error
and skips its (expensive) evaluation rather than crashing the loop.

## Projection + reconciliation

`projectAll(spec)` (`src/engine/project.ts`) runs every enabled adapter and
collects `FileOutput`s. Multiple tools legitimately want the same file — every
target reads `AGENTS.md` at the project root. The engine:

- **Dedupes** identical outputs into one `ResolvedOutput`, recording which targets
  contributed it (`targets: ['claude-code', 'codex', ...]`).
- **Reports conflicts** when two targets want the *same path* with *different*
  content, instead of letting last-writer-wins corrupt the tree.

## Write vs verify share one source of truth

`src/engine/write.ts` computes the *same* `expectedBytes()` for both `apply`
(write) and `verify` (drift diff), so the two can never disagree about what
"correct" means. Drift compares **effective content** (following symlinks), so a
symlinked and a copied `AGENTS.md` both count as in-sync.

## A `FileOutput` is one of three things

```ts
{ path, contents }        // generated file (the common case)
{ path, symlinkTo }       // relative symlink (byte-identical instructions/skills)
{ path, copyFrom }        // verbatim copy of a source file (binary skill assets)
```

Plus `capability`, `scope` (`project` | `user`), and an optional human `note`
(e.g. "place this global config by hand here").

## Adding a target

1. Write `src/targets/<tool>.ts` exporting an `Adapter`.
2. Register it in `src/targets/registry.ts`.
3. Add its id to the `TargetId` union in `canonical.ts`.

The adapter declares what *it* needs; the engine handles dedupe, conflicts, and
writing. Reuse `src/targets/shared.ts` for the common AGENTS.md / skills / markdown
emitters.
