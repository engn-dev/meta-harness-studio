/**
 * The canonical, resolved harness model.
 *
 * Everything in `.harness/` parses into a single `HarnessSpec`. Adapters read
 * this shape and project it onto a specific tool — they never touch the raw
 * TOML/Markdown. Keeping one in-memory model is what lets us add a target
 * without rewriting the engine.
 */

export type TargetId = 'claude-code' | 'codex' | 'opencode' | 'cline' | 'kilo' | 'pi';

export const ALL_TARGETS: TargetId[] = ['claude-code', 'codex', 'opencode', 'cline', 'kilo', 'pi'];

export type ProjectionMode = 'generate' | 'symlink';

export interface Manifest {
  name: string;
  targets: TargetId[];
  projection: {
    mode: ProjectionMode;
    commitGenerated: boolean;
    overrides: Partial<Record<TargetId, ProjectionMode>>;
  };
  optimizer: {
    proposer: string;
    searchSet: string;
    testSet: string;
    objectives: string[];
    maxIterations: number;
    candidatesPerIteration: number;
  };
}

export type McpTransport = 'stdio' | 'http';
export type McpScope = 'project' | 'user' | 'local';

export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  /** Values are `${ENV}` references — never literal secrets. */
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  bearerTokenEnvVar?: string;
  scope: McpScope;
  enabled: boolean;
}

export interface PermissionRule {
  tool: string;
  /** Optional glob/argument pattern, e.g. `npm run *` or `./.env*`. */
  pattern?: string;
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface PermissionSpec {
  defaultMode: 'allow' | 'ask' | 'deny';
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
  sandbox: { mode: SandboxMode; network: boolean };
}

export type EnforceEvent = 'pre-tool' | 'post-tool' | 'user-prompt' | 'stop' | 'session-start';
export type EnforceAction = 'deny' | 'warn' | 'run';

/** A "must-happen" invariant that compiles to deterministic hooks where the target supports them. */
export interface EnforceRule {
  id: string;
  description: string;
  event: EnforceEvent;
  /** Tool matcher, e.g. `Read`, `Edit|Write`, or `*`. */
  match: string;
  action: EnforceAction;
  /** Shell command to run when action is `run`. */
  run?: string;
  /** Optional file globs that scope the rule. */
  whenFiles: string[];
  message: string;
}

/** An AGENTS.md (root or nested per-package) — the portable instruction backbone. */
export interface InstructionDoc {
  /** Path relative to the project root, e.g. `AGENTS.md` or `packages/api/AGENTS.md`. */
  path: string;
  scope: 'project';
  body: string;
}

export interface SkillDef {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  /** Absolute path to the skill directory (for copying supporting assets). */
  dir: string;
  /** Supporting asset filenames alongside SKILL.md. */
  assets: string[];
}

export interface AgentDef {
  name: string;
  description: string;
  body: string;
  tools?: string[];
  model?: string;
  frontmatter: Record<string, unknown>;
}

export interface CommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface OutputStyleDef {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface HarnessSpec {
  /** Absolute path to the project root (parent of `.harness/`). */
  root: string;
  /** Absolute path to `.harness/`. */
  harnessDir: string;
  manifest: Manifest;
  instructions: InstructionDoc[];
  mcp: McpServer[];
  permissions: PermissionSpec;
  enforce: EnforceRule[];
  skills: SkillDef[];
  agents: AgentDef[];
  commands: CommandDef[];
  outputStyles: OutputStyleDef[];
}

/** The root AGENTS.md body, or empty string if none. */
export function rootInstructions(spec: HarnessSpec): string {
  const root = spec.instructions.find((d) => d.path === 'AGENTS.md');
  return root ? root.body : '';
}
