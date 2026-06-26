/**
 * The proposer — a swappable coding agent that reads the history store and
 * edits the candidate harness.
 *
 * The paper's insight is "interface, not algorithm": we don't implement search,
 * we hand a strong coding agent grep/cat access to `history/` and let it
 * self-direct. Two modes:
 *   - `simulated` (default): a deterministic, token-free editor that compresses
 *     instructions while preserving required content — a faithful, testable
 *     analog of the paper's "equal pass-rate at fewer tokens".
 *   - a shell command (e.g. `claude -p`): the real proposer, opt-in. We write a
 *     minimal steering prompt and let the agent rewrite the candidate harness.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fs, readText, writeText, pathExists } from '../util/fs.js';
import { hashDir } from '../util/hash.js';

export interface ProposerResult {
  changed: boolean;
  diagnosis: string;
}

const REDUNDANT_BLOCK = /<!--\s*harness:redundant\s*-->[\s\S]*?<!--\s*\/harness:redundant\s*-->\n?/g;

function compress(text: string): string {
  return text
    .replace(REDUNDANT_BLOCK, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n');
}

async function simulatedProposer(candidateHarnessDir: string): Promise<ProposerResult> {
  const agentsPath = path.join(candidateHarnessDir, 'AGENTS.md');
  if (!(await pathExists(agentsPath))) {
    return { changed: false, diagnosis: 'No AGENTS.md to optimize.' };
  }
  const before = await readText(agentsPath);
  const after = compress(before);
  if (after === before) {
    return {
      changed: false,
      diagnosis:
        'Hypothesis: instructions are already minimal — no redundant block or excess whitespace found. Converged on the context-token axis.',
    };
  }
  await writeText(agentsPath, after);
  const saved = before.length - after.length;
  return {
    changed: true,
    diagnosis: `Diagnosis: AGENTS.md carried a redundant block and loose whitespace inflating context with no task value.
Edit: removed the \`harness:redundant\` block and collapsed whitespace (${saved} chars / ~${Math.ceil(
      saved / 4,
    )} tokens).
Expectation: context_tokens decreases; pass_rate unchanged (required content preserved, guarded by the search set).`,
  };
}

const STEERING_PROMPT = `You are improving an agent "harness" (the .harness/ directory in your CWD).
Read ../  (the experience store: sibling history/<id>/ dirs each with harness/, scores.json, traces/, diagnosis.md).
Diagnose failures from the RAW traces, then edit THIS candidate's .harness/ files to improve the objectives
(higher pass_rate, lower context_tokens / wall_clock / cost). Do NOT touch the eval set or secrets.
Write a short root-cause diagnosis to diagnosis.md, then make the edit that tests it.`;

async function shellProposer(
  proposer: string,
  candidateHarnessDir: string,
): Promise<ProposerResult> {
  const before = await hashDir(candidateHarnessDir);
  const promptPath = path.join(candidateHarnessDir, '..', 'PROPOSER_PROMPT.md');
  await writeText(promptPath, STEERING_PROMPT);

  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn('sh', ['-c', proposer], { cwd: candidateHarnessDir });
    let output = '';
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    child.stdin?.write(STEERING_PROMPT);
    child.stdin?.end();
    child.on('error', (e) => resolve({ code: 127, output: `[proposer spawn error] ${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 0, output }));
  });

  const after = await hashDir(candidateHarnessDir);
  const changed = before !== after;
  return {
    changed,
    diagnosis: `Real proposer \`${proposer}\` exited ${result.code}; harness ${changed ? 'modified' : 'unchanged'}.\n\n${result.output.slice(0, 4000)}`,
  };
}

export async function runProposer(opts: {
  proposer: string;
  candidateHarnessDir: string;
}): Promise<ProposerResult> {
  if (opts.proposer === 'simulated') return simulatedProposer(opts.candidateHarnessDir);
  return shellProposer(opts.proposer, opts.candidateHarnessDir);
}

export { fs };
