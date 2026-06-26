/**
 * `harness optimize` — the closed loop the paper describes, made offline-friendly.
 *
 * Thin outer loop (snapshot → propose → validate → audit → evaluate → record),
 * fat proposer (it self-directs over the raw-trace history store). Multi-objective
 * Pareto reporting; held-out test split; leakage audit each iteration. Default
 * proposer is the deterministic simulated one, so this runs end-to-end with no
 * model and no tokens; pass `--proposer "claude -p"` for the real thing.
 */
import path from 'node:path';
import { requireSpec } from './common.js';
import { loadFromHarnessDir } from '../config/load.js';
import { rmrf, readTextOr, listSubdirs } from '../util/fs.js';
import { hashDir } from '../util/hash.js';
import { log, pc } from '../util/log.js';
import {
  historyDir,
  createVariantDir,
  snapshotHarness,
  writeScores,
  writeDiagnosis,
  writeTrace,
  type Variant,
  type VariantScores,
} from '../optimize/store.js';
import { loadTasks, evaluate, type EvalOutcome } from '../optimize/evaluate.js';
import { runProposer } from '../optimize/proposer.js';
import { auditLeakage } from '../optimize/audit.js';
import { paretoFrontier, objectivesFrom, type FrontierItem } from '../optimize/pareto.js';

export interface OptimizeOptions {
  iterations?: number;
  proposer?: string;
  apply?: boolean;
  keepHistory?: boolean;
}

const vid = (i: number): string => `v${String(i).padStart(2, '0')}`;

function metricsOf(s: VariantScores): Record<string, number> {
  return {
    pass_rate: s.pass_rate,
    context_tokens: s.context_tokens,
    wall_clock_s: s.wall_clock_s,
    usd: s.usd,
  };
}

function variantLine(s: VariantScores, label: string): string {
  const pass = `${(s.pass_rate * 100).toFixed(0)}%`.padStart(4);
  const tok = String(s.context_tokens).padStart(6);
  const valid = s.valid ? '' : pc.red(' invalid');
  return `  ${pc.bold(s.variantId)} ${pc.dim(label.padEnd(10))} pass ${pass}  ctx ${tok} tok  ${s.wall_clock_s}s${valid}`;
}

function lineDelta(before: string, after: string): { removed: number; added: number } {
  const b = new Set(before.split('\n'));
  const a = new Set(after.split('\n'));
  let removed = 0;
  let added = 0;
  for (const l of b) if (!a.has(l)) removed++;
  for (const l of a) if (!b.has(l)) added++;
  return { removed, added };
}

export async function runOptimize(root: string, opts: OptimizeOptions = {}): Promise<number> {
  const { spec } = await requireSpec(root, { strict: true });
  const o = spec.manifest.optimizer;
  const proposer = opts.proposer ?? o.proposer;
  const iterations = opts.iterations ?? o.maxIterations;
  if (!Number.isInteger(iterations) || iterations < 1) {
    log.error(`--iterations must be a positive integer (got ${String(opts.iterations)}).`);
    return 1;
  }

  // Only objectives we actually measure can shape the frontier. A configured key
  // we don't emit would silently never discriminate, so warn and drop it rather
  // than letting `dominates()` coerce a missing metric to a neutral value.
  const MEASURED = ['pass_rate', 'context_tokens', 'wall_clock_s', 'usd'];
  const unknownObjectives = o.objectives.filter((k) => !MEASURED.includes(k));
  if (unknownObjectives.length) {
    log.warn(`Ignoring optimizer objective(s) with no measured metric: ${unknownObjectives.join(', ')}.`);
  }
  const measured = o.objectives.filter((k) => MEASURED.includes(k));
  const objectives = objectivesFrom(measured.length ? measured : MEASURED);

  const searchDir = path.join(spec.root, o.searchSet);
  const tasks = await loadTasks(searchDir);
  if (!tasks.length) {
    log.error(`No search tasks found at ${o.searchSet}/. Each task is a directory containing task.toml.`);
    return 1;
  }
  if (o.testSet === o.searchSet) {
    log.warn('optimizer.search_set === optimizer.test_set — held-out split disabled; results may overfit.');
  }

  if (!opts.keepHistory) await rmrf(historyDir(spec.harnessDir));

  log.heading(
    `Optimizing "${spec.manifest.name}" — proposer=${pc.bold(proposer)}, ${tasks.length} search task(s), ≤${iterations} iteration(s)`,
  );

  const frontierItems: FrontierItem<VariantScores>[] = [];
  const seenHashes = new Map<string, string>();
  const allScores: VariantScores[] = [];

  const persist = async (variant: Variant, scores: VariantScores, outcome: EvalOutcome, diagnosis: string) => {
    await writeScores(variant, scores);
    await writeDiagnosis(variant, diagnosis);
    for (const run of outcome.runs) await writeTrace(variant, run.task, run.trace);
    allScores.push(scores);
  };

  // --- baseline ---
  // With --keep-history, continue numbering after the highest existing variant so
  // a re-run appends to the experience store instead of clobbering v00/v01.
  let index = 0;
  if (opts.keepHistory) {
    const existing = await listSubdirs(historyDir(spec.harnessDir));
    const nums = existing
      .map((d) => /^v(\d+)$/.exec(d))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1] as string, 10));
    index = nums.length ? Math.max(...nums) + 1 : 0;
  }
  const base = await createVariantDir(spec.harnessDir, vid(index));
  await snapshotHarness(spec.harnessDir, base.harnessDir);
  const baseHash = await hashDir(base.harnessDir);
  const baseOutcome = await evaluate(base.harnessDir, tasks);
  const baseScores: VariantScores = { variantId: base.id, ...baseOutcome.scores, hash: baseHash };
  await persist(base, baseScores, baseOutcome, 'Baseline harness (unmodified).');
  seenHashes.set(baseHash, base.id);
  frontierItems.push({ id: base.id, metrics: metricsOf(baseScores), item: baseScores });
  log.info(variantLine(baseScores, 'baseline'));

  const baselineAgents = await readTextOr(path.join(base.harnessDir, 'AGENTS.md'));
  let parent: { id: string; harnessDir: string } = { id: base.id, harnessDir: base.harnessDir };

  // --- iterations ---
  for (let i = 1; i <= iterations; i++) {
    index++;
    const cand = await createVariantDir(spec.harnessDir, vid(index));
    await snapshotHarness(parent.harnessDir, cand.harnessDir);

    const prop = await runProposer({ proposer, candidateHarnessDir: cand.harnessDir });

    // Interface-validation gate (before any expensive eval).
    const load = await loadFromHarnessDir(cand.harnessDir, cand.dir);
    if (!load.spec || load.errors.length) {
      const err = load.errors.map((e) => `${e.file}: ${e.message}`).join('; ');
      const scores: VariantScores = {
        variantId: cand.id,
        parent: parent.id,
        pass_rate: 0,
        passed: 0,
        total: tasks.length,
        context_tokens: 0,
        wall_clock_s: 0,
        usd: 0,
        valid: false,
        error: err,
      };
      await writeScores(cand, scores);
      await writeDiagnosis(cand, `${prop.diagnosis}\n\nINTERFACE VALIDATION FAILED: ${err}`);
      allScores.push(scores);
      log.info(variantLine(scores, 'invalid'));
      // Discard this candidate and retry from the unchanged parent next iteration
      // (a malformed proposer edit shouldn't end the whole run). Bounded by `iterations`.
      continue;
    }

    const hash = await hashDir(cand.harnessDir);
    if (!prop.changed || seenHashes.has(hash)) {
      await writeDiagnosis(cand, prop.diagnosis);
      log.info(`  ${pc.dim(cand.id)} converged — proposer found no further improvement.`);
      break;
    }

    const leaks = await auditLeakage(cand.harnessDir, tasks.map((t) => t.name));
    const outcome = await evaluate(cand.harnessDir, tasks);
    const scores: VariantScores = { variantId: cand.id, parent: parent.id, ...outcome.scores, hash };
    const leakNote = leaks.length ? `\n\nLEAKAGE: ${leaks.map((l) => l.detail).join('; ')}` : '';
    await persist(cand, scores, outcome, prop.diagnosis + leakNote);
    seenHashes.set(hash, cand.id);

    if (leaks.length) {
      log.warn(`  ${cand.id}: ${leaks.length} leakage finding(s) — kept off the reported frontier.`);
      log.info(variantLine(scores, 'leaking'));
    } else {
      frontierItems.push({ id: cand.id, metrics: metricsOf(scores), item: scores });
      log.info(variantLine(scores, 'candidate'));
      parent = { id: cand.id, harnessDir: cand.harnessDir };
    }
  }

  // --- frontier + summary ---
  const frontier = paretoFrontier(frontierItems, objectives);
  log.heading('Pareto frontier (non-dominated variants)');
  for (const f of frontier) log.info(variantLine(f.item, 'frontier'));

  const best =
    [...frontier]
      .sort((a, b) => b.item.pass_rate - a.item.pass_rate || a.item.context_tokens - b.item.context_tokens)[0] ??
    frontierItems[0];

  if (best && best.id !== base.id) {
    const dTok = baseScores.context_tokens - best.item.context_tokens;
    const dPass = best.item.pass_rate - baseScores.pass_rate;
    const bestAgents = await readTextOr(path.join(historyDir(spec.harnessDir), best.id, 'harness', 'AGENTS.md'));
    const delta = lineDelta(baselineAgents, bestAgents);
    log.heading('Result');
    log.success(
      `Best variant ${pc.bold(best.id)}: context_tokens ${baseScores.context_tokens} → ${best.item.context_tokens} (${dTok >= 0 ? '−' : '+'}${Math.abs(dTok)} tok), pass_rate ${(baseScores.pass_rate * 100).toFixed(0)}% → ${(best.item.pass_rate * 100).toFixed(0)}% (${dPass >= 0 ? '+' : ''}${(dPass * 100).toFixed(0)} pts).`,
    );
    log.dim(`  AGENTS.md diff vs baseline: −${delta.removed} / +${delta.added} lines (human-auditable in history/${best.id}/).`);
  } else {
    log.heading('Result');
    log.info('No variant improved on the baseline.');
  }

  // --- held-out test split (proposer never saw these) ---
  // Report the best variant's held-out pass-rate AND compare it to the baseline's:
  // a drop means the proposer improved the search metrics by overfitting, so we
  // warn rather than silently recommend a variant that generalizes worse.
  let heldOutRegressed = false;
  const testDir = path.join(spec.root, o.testSet);
  if (o.testSet !== o.searchSet) {
    const testTasks = await loadTasks(testDir);
    if (testTasks.length && best && best.id !== base.id) {
      const bestHarness = path.join(historyDir(spec.harnessDir), best.id, 'harness');
      const bestTest = await evaluate(bestHarness, testTasks);
      const baseTest = await evaluate(base.harnessDir, testTasks);
      log.dim(
        `  held-out test set: pass ${(bestTest.scores.pass_rate * 100).toFixed(0)}% (baseline ${(baseTest.scores.pass_rate * 100).toFixed(0)}%) on ${testTasks.length} task(s) the proposer never saw.`,
      );
      if (bestTest.scores.pass_rate < baseTest.scores.pass_rate) {
        heldOutRegressed = true;
        log.warn(
          `  ${best.id} regressed on the held-out set (${(bestTest.scores.pass_rate * 100).toFixed(0)}% < ${(baseTest.scores.pass_rate * 100).toFixed(0)}%) — likely overfit to the search set; not recommended for adoption.`,
        );
      }
    }
  }

  // --- adopt ---
  if (opts.apply && best && best.id !== base.id && heldOutRegressed) {
    log.warn(
      `Skipped --apply: ${best.id} regressed on the held-out set. Adopt manually if intended: copy from .harness/history/${best.id}/harness/.`,
    );
  } else if (opts.apply && best && best.id !== base.id) {
    const bestHarness = path.join(historyDir(spec.harnessDir), best.id, 'harness');
    await snapshotHarness(bestHarness, spec.harnessDir);
    log.success(`Adopted ${best.id} into .harness/. Run \`harness apply\` to project it to your tools.`);
  } else if (best && best.id !== base.id) {
    log.dim(`  To adopt: re-run with --apply, or copy from .harness/history/${best.id}/harness/.`);
  }

  return 0;
}
