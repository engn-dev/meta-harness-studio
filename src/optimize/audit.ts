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
    // A bare task identifier appearing verbatim in instructions suggests the
    // harness is being tuned to specific eval tasks rather than generalizing.
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
