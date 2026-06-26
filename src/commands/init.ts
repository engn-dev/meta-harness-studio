/**
 * `harness init` — scaffold `.harness/` with a working starter, importing any
 * existing AGENTS.md / CLAUDE.md / .cursorrules so adoption isn't greenfield-only
 * (the on-ramp teams actually need). Ships a tiny eval set so `harness optimize`
 * works immediately.
 */
import path from 'node:path';
import * as p from '@clack/prompts';
import { ALL_TARGETS, type TargetId } from '../config/canonical.js';
import { pathExists, writeText, readTextOr } from '../util/fs.js';
import { log, pc } from '../util/log.js';

export interface InitOptions {
  yes?: boolean;
}

const TARGET_LABELS: Record<TargetId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex (CLI + Desktop)',
  opencode: 'OpenCode',
  cline: 'Cline',
  kilo: 'Kilo Code',
  pi: 'Pi',
};

function harnessToml(name: string, targets: TargetId[]): string {
  return `name = "${name}"
targets = [${targets.map((t) => `"${t}"`).join(', ')}]

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

function starterAgents(name: string, imported: string): string {
  const importedBlock = imported
    ? `\n## Imported instructions\n\n${imported.trim()}\n`
    : '';
  return `# ${name}

Concise, tool-agnostic instructions for any AI coding agent in this repo. This is
the single source of truth — \`harness apply\` projects it to every tool.

## Commands
- Build: \`npm run build\`
- Test: \`npm test\`
- Lint: \`npm run lint\`

## Conventions
- Keep changes minimal and match the existing style.
- Never commit secrets.
${importedBlock}
<!-- harness:redundant -->
## Notes (demo)
This block is intentionally verbose boilerplate that costs context tokens without
adding task value. Run \`harness optimize\` to watch the proposer compress it away
while keeping the Commands and Conventions above intact (guarded by the eval set).
<!-- /harness:redundant -->
`;
}

const STARTER_MCP = `# Canonical MCP servers — transpiled to each tool's native format by \`harness apply\`.
# Uncomment to add one (secrets stay as \${ENV} references, never literals):
#
# [servers.github]
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-github"]
# env = { GITHUB_TOKEN = "\${GITHUB_TOKEN}" }
# scope = "project"
`;

const STARTER_PERMISSIONS = `default_mode = "ask"

[[deny]]
tool = "Read"
pattern = "./.env*"

[sandbox]
mode = "workspace-write"
network = false
`;

const STARTER_ENFORCE = `# "Must-happen" rules. Compiled to deterministic Claude Code hooks / permission
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

const TASK = (cmd: string): string => `cmd = ${JSON.stringify(cmd)}\nexpect_exit = 0\n`;

async function writeIfAbsent(file: string, contents: string): Promise<boolean> {
  if (await pathExists(file)) return false;
  await writeText(file, contents);
  return true;
}

export async function runInit(root: string, opts: InitOptions = {}): Promise<number> {
  const harnessDir = path.join(root, '.harness');
  if (await pathExists(path.join(harnessDir, 'harness.toml'))) {
    log.warn('.harness/harness.toml already exists. Edit it directly, or run `harness apply`.');
    return 1;
  }

  // Import on-ramp: fold any existing instruction file into the seed.
  let imported = '';
  for (const candidate of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const text = await readTextOr(path.join(root, candidate));
    if (text.trim()) {
      imported = text;
      log.dim(`Importing existing ${candidate} into the canonical AGENTS.md.`);
      break;
    }
  }

  let name = path.basename(root);
  let targets: TargetId[] = [...ALL_TARGETS];

  if (!opts.yes) {
    p.intro(pc.bold('meta-harness-studio'));
    const nameRes = await p.text({
      message: 'Project name',
      defaultValue: name,
      placeholder: name,
    });
    if (p.isCancel(nameRes)) {
      p.cancel('Cancelled.');
      return 1;
    }
    if (nameRes) name = nameRes;

    const targetRes = await p.multiselect({
      message: 'Which tools should this harness target?',
      options: ALL_TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] })),
      initialValues: [...ALL_TARGETS],
      required: true,
    });
    if (p.isCancel(targetRes)) {
      p.cancel('Cancelled.');
      return 1;
    }
    targets = targetRes as TargetId[];
  }

  // Write the canonical spec.
  await writeIfAbsent(path.join(harnessDir, 'harness.toml'), harnessToml(name, targets));
  await writeIfAbsent(path.join(harnessDir, 'AGENTS.md'), starterAgents(name, imported));
  await writeIfAbsent(path.join(harnessDir, 'mcp.toml'), STARTER_MCP);
  await writeIfAbsent(path.join(harnessDir, 'permissions.toml'), STARTER_PERMISSIONS);
  await writeIfAbsent(path.join(harnessDir, 'enforce.toml'), STARTER_ENFORCE);
  await writeIfAbsent(path.join(harnessDir, 'skills', 'example-skill', 'SKILL.md'), STARTER_SKILL);
  await writeIfAbsent(path.join(harnessDir, 'commands', 'review.md'), STARTER_COMMAND);

  // A tiny eval set so `harness optimize` works out of the box.
  await writeIfAbsent(
    path.join(root, 'eval', 'search', 'keeps-build-command', 'task.toml'),
    TASK('grep -q "npm run build" "$HARNESS_DIR/AGENTS.md"'),
  );
  await writeIfAbsent(
    path.join(root, 'eval', 'search', 'keeps-secrets-rule', 'task.toml'),
    TASK('grep -q "Never commit secrets" "$HARNESS_DIR/AGENTS.md"'),
  );
  await writeIfAbsent(
    path.join(root, 'eval', 'test', 'keeps-test-command', 'task.toml'),
    TASK('grep -q "npm test" "$HARNESS_DIR/AGENTS.md"'),
  );

  if (!opts.yes) {
    p.note(
      `harness apply       project to ${targets.length} tool(s)\nharness verify      drift + staleness + enforcement audit\nharness optimize    close the loop (simulated proposer, no tokens)`,
      'Next steps',
    );
    p.outro(pc.green('Harness scaffolded in .harness/'));
  } else {
    log.success(`Scaffolded .harness/ for "${name}" → ${targets.join(', ')}`);
    log.dim('Next: harness apply • harness verify • harness optimize');
  }
  return 0;
}
