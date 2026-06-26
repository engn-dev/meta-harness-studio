/**
 * Leakage / overfitting audit.
 *
 * Code-space optimization is *inspectable* — the paper turns that into a feature.
 * Every iteration we scan a candidate for the tells the paper names: harness text
 * that hard-codes the identity of held-out search tasks (gaming the eval rather
 * than generalizing). Findings warn the user and keep a candidate off the
 * reported frontier.
 */
import path from 'node:path';
import { glob } from 'tinyglobby';
import { readTextOr, readText } from '../util/fs.js';

export interface LeakFinding {
  kind: 'task-id-leak';
  detail: string;
}

export async function auditLeakage(
  candidateHarnessDir: string,
  taskNames: string[],
): Promise<LeakFinding[]> {
  const findings: LeakFinding[] = [];
  let text = await readTextOr(path.join(candidateHarnessDir, 'AGENTS.md'));
  for (const rel of await glob('instructions/**/AGENTS.md', { cwd: candidateHarnessDir })) {
    text += '\n' + (await readText(path.join(candidateHarnessDir, rel)));
  }
  for (const name of taskNames) {
    // Only treat slug-like task ids (containing `-` or `_`, e.g. `keeps-build-command`)
    // as leak signals. A bare common word like `test` or `build` legitimately appears
    // in normal instructions, and flagging it would silently kill real improvements —
    // the heuristic must not be more aggressive than the signal it relies on.
    if (!/[-_]/.test(name)) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(text)) {
      findings.push({
        kind: 'task-id-leak',
        detail: `instructions reference search-task id '${name}' verbatim — possible overfitting to the eval set.`,
      });
    }
  }
  return findings;
}
