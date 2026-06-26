/**
 * Evaluate a candidate harness against a held-out task set.
 *
 * A task is a directory with a `task.toml` describing a deterministic check
 * (`cmd`, expected exit, optional stdout substring). The command runs with
 * `HARNESS_DIR` pointed at the candidate's `.harness/`, so tasks assert against
 * the *candidate* instructions — e.g. "the build command is still documented",
 * which guards the optimizer from compressing away essential context.
 *
 * The combined stdout+stderr of every task is stored as a RAW trace. Offline,
 * `context_tokens` is estimated from instruction size (chars/4) so the optimizer
 * can pursue the paper's "equal pass-rate at fewer tokens" objective honestly,
 * without a model in the loop.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { glob } from 'tinyglobby';
import { fs, pathExists, readText, readTextOr, listSubdirs } from '../util/fs.js';
import type { VariantScores } from './store.js';

export interface EvalTask {
  name: string;
  dir: string;
  cmd: string;
  expectExit: number;
  expectStdoutContains?: string;
}

export interface TaskRun {
  task: string;
  passed: boolean;
  exitCode: number;
  trace: string;
}

export interface EvalOutcome {
  scores: Omit<VariantScores, 'variantId' | 'parent'>;
  runs: TaskRun[];
}

export async function loadTasks(setDir: string): Promise<EvalTask[]> {
  const tasks: EvalTask[] = [];
  for (const name of (await listSubdirs(setDir)).sort()) {
    const dir = path.join(setDir, name);
    const tomlPath = path.join(dir, 'task.toml');
    if (!(await pathExists(tomlPath))) continue;
    const raw = parseToml(await readText(tomlPath)) as Record<string, unknown>;
    if (typeof raw.cmd !== 'string') continue;
    tasks.push({
      name,
      dir,
      cmd: raw.cmd,
      expectExit: typeof raw.expect_exit === 'number' ? raw.expect_exit : 0,
      expectStdoutContains:
        typeof raw.expect_stdout_contains === 'string' && raw.expect_stdout_contains
          ? raw.expect_stdout_contains
          : undefined,
    });
  }
  return tasks;
}

function runCmd(
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));
    child.on('error', (e) => resolve({ code: 127, output: output + `\n[spawn error] ${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 0, output }));
  });
}

/** chars/4 estimate over the candidate's instruction files. */
export async function estimateContextTokens(harnessDir: string): Promise<number> {
  let chars = 0;
  chars += (await readTextOr(path.join(harnessDir, 'AGENTS.md'))).length;
  for (const rel of await glob('instructions/**/AGENTS.md', { cwd: harnessDir })) {
    chars += (await readText(path.join(harnessDir, rel))).length;
  }
  return Math.ceil(chars / 4);
}

export async function evaluate(candidateHarnessDir: string, tasks: EvalTask[]): Promise<EvalOutcome> {
  const runs: TaskRun[] = [];
  const start = process.hrtime.bigint();
  const env = { ...process.env, HARNESS_DIR: candidateHarnessDir };

  for (const task of tasks) {
    const { code, output } = await runCmd(task.cmd, task.dir, env);
    const exitOk = code === task.expectExit;
    const stdoutOk = task.expectStdoutContains ? output.includes(task.expectStdoutContains) : true;
    const passed = exitOk && stdoutOk;
    runs.push({
      task: task.name,
      passed,
      exitCode: code,
      trace: `$ ${task.cmd}\n[exit ${code}, expected ${task.expectExit}]\n${output}`,
    });
  }

  const wallClock = Number(process.hrtime.bigint() - start) / 1e9;
  const passed = runs.filter((r) => r.passed).length;
  const total = runs.length;
  const contextTokens = await estimateContextTokens(candidateHarnessDir);

  return {
    runs,
    scores: {
      pass_rate: total ? passed / total : 1,
      passed,
      total,
      context_tokens: contextTokens,
      wall_clock_s: Number(wallClock.toFixed(4)),
      usd: 0,
      valid: true,
    },
  };
}

export { fs };
