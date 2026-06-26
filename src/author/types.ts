/**
 * Shared data model for `harness author` (Phase 0 — deterministic, no LLM).
 *
 * `scanRepo` reads an arbitrary project into a `RepoDigest`. The render layer
 * turns that digest into the `.harness/` artifacts, and eval-gen mines canaries
 * from it. Keeping one in-memory digest is what lets the deterministic author and
 * a later LLM author share the same downstream pipeline.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * A command an agent in this repo would actually run. `script` is set only when
 * the command maps to a `package.json` script, so the renderer can emit
 * `<pm> run <script>` knowing `detectStaleScripts` will not flag it.
 */
export interface DetectedCommand {
  /** Canonical role: build | test | lint | typecheck | dev | start | <other>. */
  kind: string;
  /** The exact shell invocation, e.g. `npm run build`, `pytest`, `cargo test`. */
  cmd: string;
  /** The package.json script name, when this command maps to one. */
  script?: string;
}

/**
 * An MCP server inferred from the repo's stack. Phase 0 renders these as
 * COMMENTED `mcp.toml` blocks (consent-gated opt-in) plus a console checklist —
 * never live, so they can't leak secrets or alter projection until the
 * maintainer uncomments them. Values in `env` are `${ENV}` references only.
 */
export interface DetectedMcpServer {
  /** Server key under `[servers.<name>]`. */
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args: string[];
  /** `${ENV}`-reference values only — never literal secrets. */
  env: Record<string, string>;
  url?: string;
  /** The dependency/file signal that triggered this suggestion (for the checklist). */
  reason: string;
  /** Env var names the maintainer must supply to actually enable the server. */
  requiredEnv: string[];
}

/** Non-command signals used to author permissions/enforce and infer MCP. */
export interface RepoSignals {
  /** A `.env`/`.env.*` file exists at the root. */
  hasEnvFiles: boolean;
  /** Build output dir that should be protected from hand-edits, if any. */
  buildOutputDir?: string;
  /** A `.github/` directory exists. */
  hasGithubDir: boolean;
  /** Any CI config was detected (.github/workflows, .gitlab-ci.yml, etc.). */
  hasCI: boolean;
  /** Raw dependency names (prod + dev) used for framework/MCP inference. */
  dependencies: string[];
}

export interface RepoDigest {
  /** Project name (package.json name, else directory basename). */
  name: string;
  /** One-line description from package.json/README, if found. */
  description?: string;
  /** Absolute project root. */
  root: string;
  packageManager?: PackageManager;
  /** Human-readable languages, most-prominent first, e.g. ['TypeScript']. */
  languages: string[];
  /** Detected frameworks/libraries worth naming, e.g. ['React', 'Express']. */
  frameworks: string[];
  /** Commands an agent should know; order = build, test, lint, typecheck, then rest. */
  commands: DetectedCommand[];
  /** Load-bearing paths (entrypoints, key configs), repo-relative, deduped. */
  keyPaths: string[];
  /** Monorepo package dirs (repo-relative); empty for single-package repos. */
  workspaces: string[];
  /** MCP servers inferred from the stack (rendered commented + as a checklist). */
  mcpServers: DetectedMcpServer[];
  signals: RepoSignals;
  /** Existing AGENTS.md/CLAUDE.md/.cursorrules content, trimmed, if present. */
  imported?: string;
}

/** One file the author writes, with its path relative to `.harness/`. */
export interface AuthoredFile {
  /** Path relative to the `.harness/` dir, e.g. `AGENTS.md`, `skills/x/SKILL.md`. */
  rel: string;
  content: string;
}

/** Report from eval-gen: which canaries survived validate-then-keep. */
export interface EvalGenReport {
  kept: string[];
  dropped: Array<{ name: string; reason: string }>;
}

/**
 * Contract for `mcp-map.ts` (written alongside this file):
 *
 *   export function inferMcpServers(signals: RepoSignals): DetectedMcpServer[];
 *
 * Keyed on `signals.dependencies` + the boolean signals. Returns at most ~5
 * servers, each with `${ENV}`-only env values.
 */
