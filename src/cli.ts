#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runAuthor } from './commands/author.js';
import { runApply } from './commands/apply.js';
import { runVerify } from './commands/verify.js';
import { runOptimize } from './commands/optimize.js';
import { runListTargets, runDoctor } from './commands/doctor.js';
import { setQuiet, log } from './util/log.js';

const program = new Command();

program
  .name('harness')
  .description(
    'Author one harness, project it onto Claude Code, Codex, OpenCode, Cline, Kilo Code and Pi — then close the loop and let an agentic proposer improve it from execution traces.',
  )
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'run as if in this directory', process.cwd())
  .option('-q, --quiet', 'reduce output', false);

function ctx(): string {
  const g = program.opts<{ cwd: string; quiet: boolean }>();
  setQuiet(Boolean(g.quiet));
  return path.resolve(g.cwd);
}

async function run(fn: () => Promise<number> | number): Promise<void> {
  try {
    const code = await fn();
    if (code) process.exitCode = code;
  } catch (e) {
    log.error((e as Error).message);
    process.exitCode = 1;
  }
}

program
  .command('init')
  .description('scaffold .harness/ (imports an existing AGENTS.md/CLAUDE.md if present)')
  .option('-y, --yes', 'use defaults, no prompts', false)
  .option('--from-repo', 'author content from a repo scan instead of a fixed skeleton', false)
  .option('-p, --proposer <cmd>', 'with --from-repo: opt-in LLM authoring pass (e.g. "claude -p")')
  .option('--optimize', 'with --from-repo: chain `harness optimize` after authoring', false)
  .action((opts: { yes: boolean; fromRepo: boolean; proposer?: string; optimize: boolean }) => {
    if ((opts.proposer || opts.optimize) && !opts.fromRepo) {
      log.warn('--proposer/--optimize only apply with --from-repo; ignoring.');
    }
    return run(() =>
      opts.fromRepo
        ? runAuthor(ctx(), { proposer: opts.proposer, optimize: opts.optimize })
        : runInit(ctx(), { yes: opts.yes }),
    );
  });

program
  .command('author')
  .description('scan the repo and auto-author a working .harness/ (deterministic, no tokens)')
  .option('-f, --force', 'overwrite existing .harness/ files', false)
  .option(
    '-p, --proposer <cmd>',
    'opt-in LLM authoring pass: a shell command (e.g. "claude -p"); validate-or-revert',
  )
  .option('--optimize', 'chain `harness optimize` (simulated proposer) after authoring', false)
  .action((opts: { force: boolean; proposer?: string; optimize: boolean }) =>
    run(() => runAuthor(ctx(), { force: opts.force, proposer: opts.proposer, optimize: opts.optimize })),
  );

program
  .command('apply')
  .description('project the canonical .harness/ onto every enabled tool')
  .option('-n, --dry-run', 'preview without writing', false)
  .action((opts: { dryRun: boolean }) => run(() => runApply(ctx(), { dryRun: opts.dryRun })));

program
  .command('verify')
  .description('audit drift, stale script references, and enforcement coverage')
  .action(() => run(() => runVerify(ctx())));

program
  .command('optimize')
  .description('close the loop: propose harness edits from execution feedback (Pareto)')
  .option('-i, --iterations <n>', 'max iterations', (v) => parseInt(v, 10))
  .option('-p, --proposer <cmd>', 'proposer: "simulated" or a shell command (e.g. "claude -p")')
  .option('--apply', 'adopt the best variant into .harness/', false)
  .option('--keep-history', 'append to history/ instead of clearing it', false)
  .action((opts: { iterations?: number; proposer?: string; apply: boolean; keepHistory: boolean }) =>
    run(() =>
      runOptimize(ctx(), {
        iterations: opts.iterations,
        proposer: opts.proposer,
        apply: opts.apply,
        keepHistory: opts.keepHistory,
      }),
    ),
  );

program
  .command('list-targets')
  .description('show the capability matrix across all targets')
  .action(() => run(() => runListTargets()));

program
  .command('doctor')
  .description('check Node and which agent CLIs are installed')
  .action(() => run(() => runDoctor()));

program.parseAsync(process.argv);
