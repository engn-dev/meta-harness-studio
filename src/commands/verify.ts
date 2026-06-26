/**
 * `harness verify` — the auditor. Three checks no static sync tool runs together:
 *   1. Drift: are generated tool files in sync with the canonical spec?
 *   2. Staleness: do instructions reference npm scripts that still exist?
 *   3. Enforcement coverage: which "must-happen" rules are deterministically
 *      enforced vs advisory-only, per target?
 * Exits non-zero on any problem, so it's usable as a CI gate.
 */
import { requireSpec, printErrors } from './common.js';
import { projectAll } from '../engine/project.js';
import { diffOutputs } from '../engine/write.js';
import { detectStaleScripts } from '../engine/staleness.js';
import { compileClaudeEnforcement } from '../enforce/hooks.js';
import { log, pc } from '../util/log.js';

export async function runVerify(root: string): Promise<number> {
  const { spec, errors } = await requireSpec(root, { strict: false });
  let problems = 0;

  if (errors.length) {
    log.heading('Validation');
    printErrors(errors);
    problems += errors.length;
  }

  const plan = projectAll(spec);
  if (plan.conflicts.length) {
    log.heading('Conflicts');
    for (const c of plan.conflicts) log.error(c.path);
    problems += plan.conflicts.length;
  }

  // 1. Drift
  log.heading('Drift (generated vs canonical)');
  const drift = await diffOutputs(plan.outputs, spec.root);
  const out = drift.filter((d) => d.status !== 'match');
  if (out.length === 0) {
    log.success(`${drift.length} projected file(s) in sync.`);
  } else {
    for (const d of out) {
      problems++;
      log.warn(`${d.status === 'missing' ? pc.red('missing') : pc.yellow('changed')}  ${d.path}`);
    }
    log.dim('  → run `harness apply` to regenerate.');
  }

  // 2. Staleness
  log.heading('Staleness (referenced scripts)');
  const stale = await detectStaleScripts(spec);
  if (stale.length === 0) {
    log.success('No stale script references found.');
  } else {
    for (const s of stale) {
      problems++;
      log.warn(`${pc.dim(s.source)} → ${s.reason}`);
    }
  }

  // 3. Enforcement coverage
  log.heading('Enforcement coverage');
  if (spec.enforce.length === 0) {
    log.dim('No enforce.toml rules declared.');
  } else {
    const compiled = compileClaudeEnforcement(spec.enforce);
    const hookCount = Object.values(compiled.hooks).reduce((n, arr) => n + arr.length, 0);
    log.info(
      `  ${pc.green('deterministic')}  claude-code: ${hookCount} hook(s) + ${compiled.deny.length} deny rule(s)`,
    );
    const advisory = spec.manifest.targets.filter((t) => t !== 'claude-code');
    if (advisory.length) {
      log.info(`  ${pc.yellow('advisory only')}  ${advisory.join(', ')} (no portable hook layer)`);
    }
    for (const w of compiled.warnings) log.dim(`  note: ${w}`);
  }

  log.heading(problems === 0 ? pc.green('✔ Harness verified — no problems.') : pc.red(`✘ ${problems} problem(s) found.`));
  return problems === 0 ? 0 : 1;
}
