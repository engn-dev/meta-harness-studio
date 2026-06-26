/**
 * Mine "canary" eval tasks from a `RepoDigest` so `harness optimize` can't silently
 * compress away the authored AGENTS.md's load-bearing facts.
 *
 * Each canary is a grep against the candidate's AGENTS.md for a literal substring
 * the renderer guarantees is present (a command, a key path, the secrets rule).
 * The crucial discipline is VALIDATE-THEN-KEEP: every candidate is run via the real
 * `evaluate` against the freshly-authored harness *before* it is kept. A canary that
 * fails on the true harness is a false positive that would peg pass_rate below 100%
 * from iteration zero — so we delete it and record why, rather than shipping a guard
 * that lies about what the document contains.
 */
import path from 'node:path';
import { pathExists, writeText, rmrf } from '../util/fs.js';
import { evaluate, type EvalTask } from '../optimize/evaluate.js';
import type { RepoDigest, EvalGenReport } from './types.js';

const MAX_KEY_PATHS = 5;
const TASK_TOML = (cmd: string): string => `cmd = ${JSON.stringify(cmd)}\nexpect_exit = 0\n`;

/** Lowercase, collapse to `[a-z0-9-]`, trim dashes. Stable, dependency-free. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A grep needle is embedded in a double-quoted `sh -c` string, so every character
 * that still has meaning there must be rejected — `"` (closes the string), `$`
 * (expansion), `\` (escape), and `` ` `` (command substitution, an arbitrary-code
 * vector when scanning an untrusted repo) — plus control chars / newlines. Needles
 * come from on-disk filenames and command strings, so this is the security gate,
 * not a convenience. Callers shrink to a safe core substring before reaching here.
 */
function safeNeedle(s: string): boolean {
  if (!s.length || /["$\\`]/.test(s)) return false;
  // Reject control chars / newlines without embedding raw control bytes in source.
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/**
 * A canary command: assert `needle` is a literal substring of the candidate's
 * AGENTS.md. `$HARNESS_DIR` is expanded by the shell that `evaluate` spawns.
 */
const grepCmd = (needle: string): string => `grep -q "${needle}" "$HARNESS_DIR/AGENTS.md"`;

interface Candidate {
  name: string;
  needle: string;
  /** Search set (kept in optimizer's training split) or test set (held-out). */
  set: 'search' | 'test';
}

/**
 * Reduce a command to a needle the renderer reliably emits and the shell can quote.
 * Full invocations like `npm run build` are safe as-is; anything carrying a shell
 * metacharacter is unusable as a literal grep needle, so the command is skipped.
 */
function commandNeedle(cmd: string): string | undefined {
  const trimmed = cmd.trim();
  return safeNeedle(trimmed) ? trimmed : undefined;
}

function buildCandidates(d: RepoDigest): Candidate[] {
  const candidates: Candidate[] = [];

  for (const c of d.commands) {
    const needle = commandNeedle(c.cmd);
    if (!needle) continue;
    candidates.push({ name: `keeps-${slugify(c.kind)}-command`, needle, set: 'search' });
  }

  for (const p of d.keyPaths.slice(0, MAX_KEY_PATHS)) {
    if (!safeNeedle(p)) continue;
    candidates.push({ name: `mentions-${slugify(p)}`, needle: p, set: 'search' });
  }

  // Always guard the secrets rule — the renderer emits this verbatim.
  candidates.push({ name: 'keeps-secrets-rule', needle: 'Never commit secrets', set: 'search' });

  // Mirror the PRIMARY fact (build if present, else test) into the held-out test
  // split so optimize's generalization check has signal. Never put a fact ONLY in
  // test — the search copy above stays.
  const primary =
    d.commands.find((c) => c.kind === 'build') ?? d.commands.find((c) => c.kind === 'test');
  if (primary) {
    const needle = commandNeedle(primary.cmd);
    if (needle) {
      candidates.push({ name: `documents-${slugify(primary.kind)}-command`, needle, set: 'test' });
    }
  }

  // De-dup by (set, name): two commands sharing a kind would collide on the dir.
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.set}/${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function generateEvalTasks(
  d: RepoDigest,
  harnessDir: string,
  root: string,
): Promise<EvalGenReport> {
  const kept: string[] = [];
  const dropped: Array<{ name: string; reason: string }> = [];

  for (const c of buildCandidates(d)) {
    const dir = path.join(root, 'eval', c.set, c.name);
    const tomlPath = path.join(dir, 'task.toml');

    // Don't clobber a hand-written or already-emitted task with the same name.
    if (await pathExists(tomlPath)) {
      dropped.push({ name: c.name, reason: `task dir already exists at eval/${c.set}/${c.name}` });
      continue;
    }

    const cmd = grepCmd(c.needle);
    await writeText(tomlPath, TASK_TOML(cmd));

    const task: EvalTask = { name: c.name, dir, cmd, expectExit: 0 };
    const outcome = await evaluate(harnessDir, [task]);
    const run = outcome.runs[0];

    if (run?.passed) {
      kept.push(c.name);
    } else {
      // False positive against the true harness: delete it so it can't poison
      // pass_rate from iteration zero.
      await rmrf(dir);
      const exit = run ? run.exitCode : 'no run';
      dropped.push({
        name: c.name,
        reason: `canary did not pass on authored harness (needle "${c.needle}" absent from AGENTS.md; exit ${exit})`,
      });
    }
  }

  return { kept, dropped };
}
