/**
 * Phase 1 — the opt-in LLM authoring pass.
 *
 * Phase 0 writes a deterministic, guaranteed-valid `.harness/`. This pass hands a
 * coding agent (a shell command like `claude -p`) the repo plus that draft and asks
 * it to enrich AGENTS.md with genuinely load-bearing facts (architecture, gotchas)
 * that a scan can't infer. Faithful to the locked design, it is opt-in only — the
 * engine keeps its zero-runtime-model-dependency default.
 *
 * The LLM's output is UNTRUSTED. The whole `.harness/` is snapshotted first; after
 * the agent runs, the result must clear the same gates every other command uses —
 * the zod loader, `detectStaleScripts` (no hallucinated commands), and
 * `detectLiteralSecrets` (no pasted credentials). On any failure we revert to the
 * snapshot, so a bad LLM run can never ship a harness worse than the Phase 0 draft.
 */
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { promises as nodeFs } from 'node:fs';
import { copyDir, rmrf, readTextOr } from '../util/fs.js';
import { loadFromHarnessDir } from '../config/load.js';
import { detectStaleScripts } from '../engine/staleness.js';
import { detectLiteralSecrets } from '../config/secrets.js';

export interface LlmEnrichResult {
  /** True if the agent changed AGENTS.md and the result cleared every gate. */
  applied: boolean;
  /** True if the run was rolled back because it failed a gate (or made no change). */
  reverted: boolean;
  /** Human-readable outcome for the CLI report. */
  note: string;
}

/** A hung agent would block the command forever, so cap the call (mirrors optimize). */
const TIMEOUT_MS = 10 * 60 * 1000;

const STEERING_PROMPT = `You are authoring the canonical agent harness for THIS repository under .harness/
(the single source of truth an AI coding agent reads to work here).

A deterministic draft already exists. Improve it on disk:
1. .harness/AGENTS.md — ADD only genuinely load-bearing facts an agent would
   otherwise get wrong: real architecture, key modules and how they fit, non-obvious
   gotchas, project-specific conventions. Be SUBTRACTION-FIRST and concise (well
   under ~200 lines) — a short, true file beats a long one.
2. OPTIONALLY add grounded skills/subagents this repo genuinely warrants, each
   capturing a real, reusable workflow (e.g. a migration runner, a release
   checklist) — never filler:
   - a skill at .harness/skills/<new-name>/SKILL.md, frontmatter: name, description;
   - a subagent at .harness/agents/<new-name>.md, frontmatter: name, description.
   Use names not already present under skills/ or agents/. Valid YAML frontmatter
   is required, or the whole run is discarded.

HARD CONSTRAINTS (violating any discards your entire run — it reverts to the draft):
- Only reference build/test/lint commands that ACTUALLY exist (check package.json
  scripts / Makefile). Never invent a command, anywhere.
- Never write a secret. Leave .harness/mcp.toml, permissions.toml and enforce.toml
  untouched. Keep AGENTS.md's existing "## Commands" entries and the "Never commit
  secrets" line verbatim.

Modify the files on disk now. Do not print them to stdout.`;

interface SpawnOutcome {
  code: number;
  output: string;
  timedOut: boolean;
}

/** Spawn the agent at the repo root, delivering the prompt over stdin (as `claude -p` reads it). */
function runAgent(proposer: string, root: string): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const child = spawn('sh', ['-c', proposer], { cwd: root });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, TIMEOUT_MS);
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    // A proposer that ignores stdin and exits first makes this write emit EPIPE —
    // swallow it so an unread prompt never crashes the command.
    child.stdin?.on('error', () => {});
    child.stdin?.write(STEERING_PROMPT);
    child.stdin?.end();
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `[author proposer spawn error] ${e.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, output, timedOut });
    });
  });
}

/**
 * Run the opt-in LLM authoring pass over an already-authored `.harness/`. Snapshots
 * the harness, runs the agent, then validates — reverting wholesale on any gate
 * failure so the deterministic draft is the floor, never the ceiling.
 */
export async function enrichWithLlm(
  proposer: string,
  root: string,
  harnessDir: string,
): Promise<LlmEnrichResult> {
  const agentsPath = path.join(harnessDir, 'AGENTS.md');
  const before = await readTextOr(agentsPath);

  // Snapshot the WHOLE harness — the agent is told to touch only AGENTS.md, but an
  // untrusted run could edit anything, and we want a clean revert regardless.
  const snapshot = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'mhs-author-snap-'));
  await copyDir(harnessDir, snapshot);

  const restore = async (): Promise<void> => {
    await rmrf(harnessDir);
    await copyDir(snapshot, harnessDir);
  };

  try {
    const run = await runAgent(proposer, root);

    // Same gates as `verify` / the optimizer. Any failure → revert.
    const { spec, errors } = await loadFromHarnessDir(harnessDir, root);
    const stale = spec ? await detectStaleScripts(spec) : [];
    const secrets = spec ? detectLiteralSecrets(spec.mcp) : [];

    const reasons: string[] = [];
    if (run.timedOut) reasons.push(`agent timed out after ${TIMEOUT_MS / 1000}s`);
    if (errors.length || !spec) reasons.push(`harness no longer parses (${errors.length} error(s))`);
    if (stale.length) reasons.push(`${stale.length} hallucinated command reference(s)`);
    if (secrets.length) reasons.push(`${secrets.length} literal secret(s) introduced`);

    if (reasons.length) {
      await restore();
      return {
        applied: false,
        reverted: true,
        note: `LLM pass discarded — reverted to the deterministic draft: ${reasons.join('; ')}.`,
      };
    }

    const after = await readTextOr(agentsPath);
    if (after === before) {
      return { applied: false, reverted: false, note: `LLM pass made no change (agent exited ${run.code}).` };
    }
    return { applied: true, reverted: false, note: `LLM pass applied — AGENTS.md enriched (agent exited ${run.code}).` };
  } finally {
    await rmrf(snapshot);
  }
}
