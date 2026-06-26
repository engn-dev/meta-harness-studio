/**
 * Render a `RepoDigest` into the `.harness/` artifacts (Phase 0 — deterministic).
 *
 * This is the half of `harness author` that turns observed facts into files. It
 * deliberately mirrors the `harness init` starter shapes (same TOML byte-shape,
 * same `<!-- harness:redundant -->` convention) so authored output is a strict
 * superset of the hand-written scaffold and projection treats them identically.
 *
 * Two invariants are satisfied *by construction*, not by a later pass:
 *  - No `<pm> run X` is emitted unless it came from a `DetectedCommand.script`
 *    that exists, so `detectStaleScripts` never flags authored instructions.
 *  - MCP servers are rendered as COMMENTED blocks only, so `detectLiteralSecrets`
 *    has nothing live to inspect and projection is untouched until a maintainer
 *    opts in.
 * Everything emitted parses against the zod schemas in `../config/schema.ts`.
 */
import type { AuthoredFile, DetectedMcpServer, RepoDigest } from './types.js';

// TOML basic-string escaping — JSON string syntax is a valid TOML basic string,
// so a name containing `"` or `\` still produces valid TOML. Mirrors init.ts.
const tomlStr = (s: string): string => JSON.stringify(s);

// `imported` is the only unbounded input (a pre-existing AGENTS.md can be huge);
// every other section is small and bounded. Cap the imported block so the authored
// file stays near the ~200-line budget while the structural sections always survive.
const MAX_IMPORTED_LINES = 150;

/** `harness.toml` — name + the passed targets + projection/optimizer, byte-shape of init.ts. */
export function renderHarnessToml(name: string, targets: string[]): string {
  return `name = ${tomlStr(name)}
targets = [${targets.map((t) => tomlStr(t)).join(', ')}]

[projection]
mode = "generate"        # "generate" (copy) | "symlink" (byte-identical only)
commit_generated = true

[optimizer]
proposer = "simulated"   # "simulated" (token-free) | a shell command e.g. "claude -p"
search_set = "eval/search"
test_set = "eval/test"
max_iterations = 3
`;
}

/**
 * `AGENTS.md` — the centerpiece. Sections, in order: title + description,
 * Commands, Conventions, Architecture (only with real signal), then either
 * Gotchas-via-Imported or a plain Imported block, then a redundant Background
 * block. Capped at ~200 lines.
 */
export function renderAgentsMd(d: RepoDigest): string {
  const lines: string[] = [];

  // Title + one-line description.
  lines.push(`# ${d.name}`, '');
  if (d.description) {
    lines.push(d.description.trim(), '');
  }
  lines.push(
    'Canonical, tool-agnostic instructions for any AI coding agent in this repo. Single',
    'source of truth — `harness apply` projects this to every configured tool.',
    '',
  );

  // Commands — every detected command verbatim. cmd strings come from scan, where
  // `<pm> run <script>` is only produced for scripts that exist, so staleness is safe.
  lines.push('## Commands');
  for (const c of d.commands) {
    const kind = c.kind.charAt(0).toUpperCase() + c.kind.slice(1);
    lines.push(`- ${kind}: \`${c.cmd}\``);
  }
  lines.push('');

  // Conventions — the two anchor lines are mandatory (the secrets line is also an
  // eval canary). The build-output line is added only when we actually detected one.
  lines.push('## Conventions');
  lines.push('- Keep changes minimal and match the existing style.');
  lines.push(
    '- Never commit secrets. MCP env values are `${ENV}` references only, never literals.',
  );
  if (d.signals.buildOutputDir) {
    lines.push(
      `- Never hand-edit \`${d.signals.buildOutputDir}\` — it is generated output. Edit the source and rebuild.`,
    );
  }
  lines.push('');

  // Architecture — only with real signal. Subtraction-first: omit entirely if empty.
  const archLines: string[] = [];
  if (d.workspaces.length) {
    archLines.push(
      `- Monorepo: packages live under ${d.workspaces.map((w) => `\`${w}\``).join(', ')}.`,
    );
  }
  if (d.frameworks.length) {
    archLines.push(`- Stack: ${d.frameworks.join(', ')}.`);
  }
  for (const p of d.keyPaths) {
    archLines.push(`- \`${p}\` is a load-bearing path.`);
  }
  if (archLines.length) {
    lines.push('## Architecture (load-bearing facts)', ...archLines, '');
  }

  // Imported instructions — fold any existing instruction file in under a clearly
  // labeled block, exactly as init.ts does. (We don't fabricate a Gotchas section;
  // it would have no real signal in Phase 0.) Capped so a large pre-existing file
  // can't blow the line budget; pushed line-by-line so the count stays accurate.
  if (d.imported && d.imported.trim()) {
    const importLines = d.imported.trim().split('\n');
    const shown = importLines.slice(0, MAX_IMPORTED_LINES);
    if (importLines.length > MAX_IMPORTED_LINES) {
      shown.push(
        `*(imported instructions truncated — ${importLines.length - MAX_IMPORTED_LINES} more line(s) in the original)*`,
      );
    }
    lines.push('## Imported instructions', '', ...shown, '');
  }

  // Redundant Background block — verbose, compressible, guarded by the eval set.
  lines.push(
    '<!-- harness:redundant -->',
    '## Background notes (non-load-bearing)',
    'This section restates narrative context that is pleasant to read but costs context',
    'tokens without changing what an agent must do. It was authored automatically from a',
    'scan of this repository, so the Commands and Conventions above are the load-bearing',
    'parts; this prose merely paraphrases what they already say. Run `harness optimize` to',
    'watch the proposer compress this block away while the eval set guarantees every',
    'load-bearing fact above survives untouched.',
    '<!-- /harness:redundant -->',
    '',
  );

  return lines.join('\n') + '\n';
}

/**
 * `mcp.toml` — the init.ts header, then one COMMENTED block per inferred server.
 * Every line is prefixed `# `, so nothing is live: projection is untouched and no
 * literal can leak. Empty input renders just the header (parity with STARTER_MCP).
 */
export function renderMcpToml(servers: DetectedMcpServer[]): string {
  const header = `# Canonical MCP servers — transpiled to each tool's native format by \`harness apply\`.
# Uncomment to add one (secrets stay as \${ENV} references, never literals):
#
`;
  if (!servers.length) {
    // Match STARTER_MCP exactly: header + a single commented example.
    return `${header}# [servers.github]
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-github"]
# env = { GITHUB_TOKEN = "\${GITHUB_TOKEN}" }
# scope = "project"
`;
  }

  const blocks = servers.map((s) => renderCommentedMcpBlock(s));
  return header + blocks.join('#\n');
}

/** One server as a fully-commented `[servers.<name>]` block (every line `# `-prefixed). */
function renderCommentedMcpBlock(s: DetectedMcpServer): string {
  const out: string[] = [];
  out.push(`# ${s.reason}`);
  out.push(`# [servers.${s.name}]`);
  out.push(`# transport = ${tomlStr(s.transport)}`);
  if (s.command) out.push(`# command = ${tomlStr(s.command)}`);
  out.push(`# args = [${s.args.map((a) => tomlStr(a)).join(', ')}]`);
  if (s.url) out.push(`# url = ${tomlStr(s.url)}`);
  const envEntries = Object.entries(s.env);
  if (envEntries.length) {
    const inner = envEntries.map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ');
    out.push(`# env = { ${inner} }`);
  }
  out.push('# scope = "project"');
  return out.join('\n') + '\n';
}

/**
 * `permissions.toml` — STARTER_PERMISSIONS, plus an extra `[[deny]]` on the build
 * output dir when one was detected. Conservative: default_mode stays `ask`.
 */
export function renderPermissionsToml(buildOutputDir?: string): string {
  let out = `default_mode = "ask"

[[deny]]
tool = "Read"
pattern = "./.env*"
`;
  if (buildOutputDir) {
    out += `
[[deny]]
tool = "Edit|Write"
pattern = ${tomlStr(`./${buildOutputDir}/**`)}
`;
  }
  out += `
[sandbox]
mode = "workspace-write"
network = false
`;
  return out;
}

/**
 * `enforce.toml` — the known-safe STARTER_ENFORCE `block-env-read` deny, plus a
 * `warn` (never deny) on hand-edits under the detected build output dir. Mirrors
 * the live `.harness/enforce.toml` generated-dir rule, but authored as advisory.
 */
export function renderEnforceToml(buildOutputDir?: string): string {
  let out = `# "Must-happen" rules. Compiled to deterministic Claude Code hooks / permission
# denies; advisory-only where a target has no hook layer.
[[rule]]
id = "block-env-read"
description = "Block reading secret env files"
event = "pre-tool"
match = "Read"
action = "deny"
when_files = ["./.env*"]
message = "Reading .env* is blocked by harness policy."
`;
  if (buildOutputDir) {
    const dir = buildOutputDir;
    out += `
[[rule]]
id = "warn-edit-generated"
description = ${tomlStr(`${dir}/ is generated — edit source and rebuild, don't hand-edit`)}
event = "post-tool"
match = "Edit|Write"
action = "warn"
when_files = [${tomlStr(`./${dir}/**`)}]
message = ${tomlStr(`${dir}/ is generated output. Edit the source and rebuild instead of hand-editing it.`)}
`;
  }
  return out;
}

// Starter skill + command, kept byte-identical to init.ts for projection parity.
const STARTER_SKILL = `---
name: example-skill
description: A starter skill, projected to every tool that supports Agent Skills.
---

# Example skill

Replace this with a real skill. \`harness apply\` writes it to .claude/skills/,
.codex/skills/ and the shared .agents/skills/ (read by Pi and other Agent-Skills tools).
`;

const STARTER_COMMAND = `---
description: Review the current diff for correctness and simplicity.
argument-hint: "[path]"
---

Review the current diff for correctness bugs and obvious simplifications.
Focus on $ARGUMENTS if provided.
`;

/**
 * `skills/testing/SKILL.md` — the one generated skill Phase 0 ships. It is grounded
 * in detected build/test commands (never guessed) so it can't reference a missing
 * script. Rendered only when a test command was detected.
 */
function renderTestingSkill(d: RepoDigest): string {
  const test = d.commands.find((c) => c.kind === 'test');
  const build = d.commands.find((c) => c.kind === 'build');
  const body: string[] = [];
  if (build) body.push(`- Build: run \`${build.cmd}\`.`);
  if (test) body.push(`- Test: run \`${test.cmd}\`.`);
  return `---
name: testing
description: How to build and run this repo's tests.
---

# Testing

Use this repo's own commands rather than guessing a test runner:

${body.join('\n')}

Run the full suite before declaring a change done.
`;
}

/**
 * Render every `.harness/` artifact from a digest. Paths are relative to `.harness/`.
 * The `testing` skill is emitted only when the digest has a test command.
 */
export function renderHarnessFiles(d: RepoDigest, targets: string[]): AuthoredFile[] {
  const files: AuthoredFile[] = [
    { rel: 'harness.toml', content: renderHarnessToml(d.name, targets) },
    { rel: 'AGENTS.md', content: renderAgentsMd(d) },
    { rel: 'mcp.toml', content: renderMcpToml(d.mcpServers) },
    { rel: 'permissions.toml', content: renderPermissionsToml(d.signals.buildOutputDir) },
    { rel: 'enforce.toml', content: renderEnforceToml(d.signals.buildOutputDir) },
    { rel: 'skills/example-skill/SKILL.md', content: STARTER_SKILL },
    { rel: 'commands/review.md', content: STARTER_COMMAND },
  ];

  if (d.commands.some((c) => c.kind === 'test')) {
    files.push({ rel: 'skills/testing/SKILL.md', content: renderTestingSkill(d) });
  }

  return files;
}
