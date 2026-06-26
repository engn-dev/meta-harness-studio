/**
 * `harness author` — read an arbitrary repo and AUTO-AUTHOR a working `.harness/`.
 *
 * Where `init` scaffolds a fixed skeleton, `author` scans the project (commands,
 * stack, key paths, MCP-worthy deps) and writes real content, then mines a guard
 * eval set from it. The pipeline reuses the engine's existing gates verbatim:
 * the zod loader is the interface-validation gate, and render satisfies
 * `detectStaleScripts` / `detectLiteralSecrets` by construction — we re-run both
 * here only to report honestly, never to repair.
 *
 * Phase 0 is deterministic: no LLM, no tokens, reproducible. Existing files are
 * preserved unless `--force`, so re-authoring never clobbers a hand-edit silently.
 */
import path from 'node:path';
import { ALL_TARGETS } from '../config/canonical.js';
import { pathExists, writeText } from '../util/fs.js';
import { loadFromHarnessDir } from '../config/load.js';
import { detectStaleScripts } from '../engine/staleness.js';
import { detectLiteralSecrets } from '../config/secrets.js';
import { syncGitignore } from '../engine/gitignore.js';
import { scanRepo } from '../author/scan.js';
import { renderHarnessFiles } from '../author/render.js';
import { generateEvalTasks } from '../author/evalgen.js';
import { enrichWithLlm } from '../author/llm.js';
import { runOptimize } from './optimize.js';
import { log, pc } from '../util/log.js';

export interface AuthorOptions {
  /** Overwrite existing `.harness/` files instead of preserving them. */
  force?: boolean;
  /** Opt-in LLM authoring pass: a shell command (e.g. `claude -p`). Absent = deterministic only. */
  proposer?: string;
  /** Chain `harness optimize` after authoring (simulated proposer by default). */
  optimize?: boolean;
}

export async function runAuthor(root: string, opts: AuthorOptions = {}): Promise<number> {
  const harnessDir = path.join(root, '.harness');

  // 1. Scan the repo into a digest (deterministic, local signals only).
  const digest = await scanRepo(root);
  log.dim(
    `Scanned "${digest.name}" — ${digest.commands.length} command(s), ` +
      `${digest.languages.join('/') || 'no language'} detected, ` +
      `${digest.mcpServers.length} MCP suggestion(s).`,
  );

  // 2. Render the canonical artifacts (targets default to all, as `init` does).
  const files = renderHarnessFiles(digest, [...ALL_TARGETS]);

  // 3. Write, preserving existing files unless --force.
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const abs = path.join(harnessDir, f.rel);
    if (!opts.force && (await pathExists(abs))) {
      skipped.push(f.rel);
      continue;
    }
    await writeText(abs, f.content);
    written.push(f.rel);
  }

  // 4. Interface-validation gate — the same loader every other command starts at.
  // Render is built to pass this; a failure here is a real bug, surfaced precisely.
  const { spec, errors } = await loadFromHarnessDir(harnessDir, root);
  if (errors.length || !spec) {
    log.error('Authored harness failed validation:');
    for (const e of errors) log.error(`  ${e.file}: ${e.message}`);
    return 1;
  }

  // 5. Honest guard report (never repair): these must already be clean by construction.
  const stale = await detectStaleScripts(spec);
  const secrets = detectLiteralSecrets(spec.mcp);
  if (stale.length) {
    log.error('Authored instructions reference scripts that do not exist:');
    for (const s of stale) log.error(`  ${s.source}: ${s.reason}`);
    return 1;
  }
  if (secrets.length) {
    log.error('Authored mcp.toml contains literal secrets (must be ${ENV} refs):');
    for (const s of secrets) log.error(`  ${s.server}.${s.field}.${s.key}`);
    return 1;
  }

  // 5b. Opt-in LLM authoring pass (Phase 1 + decision #3). It runs against the repo
  // + the valid draft above, may enrich AGENTS.md and add grounded skills/agents,
  // then validate-or-reverts through the same gates — so a bad run can never leave
  // the harness worse than the deterministic draft.
  const newDrafts: string[] = [];
  if (opts.proposer) {
    const baseSkills = new Set(spec.skills.map((s) => `skill:${s.name}`));
    const baseAgents = new Set(spec.agents.map((a) => `agent:${a.name}`));
    log.dim(`LLM authoring pass: \`${opts.proposer}\` …`);
    const enrich = await enrichWithLlm(opts.proposer, root, harnessDir);
    if (enrich.reverted) {
      log.warn(enrich.note);
    } else {
      log.dim(enrich.note);
      // Surface any skills/agents the agent drafted so the maintainer reviews them
      // (they are projected by `apply`, so they are drafts to keep or delete).
      const { spec: after } = await loadFromHarnessDir(harnessDir, root);
      for (const s of after?.skills ?? []) {
        if (!baseSkills.has(`skill:${s.name}`)) newDrafts.push(`skill/${s.name}`);
      }
      for (const a of after?.agents ?? []) {
        if (!baseAgents.has(`agent:${a.name}`)) newDrafts.push(`agent/${a.name}`);
      }
    }
  }

  // 6. Mine the guard eval set (validate-then-keep against the final AGENTS.md).
  const evalReport = await generateEvalTasks(digest, harnessDir, root);

  // 7. Keep history/ and .generated/ ignored, mirroring init.
  await syncGitignore(root, spec, []);

  // --- Report ---
  if (written.length) log.success(`Authored .harness/ — wrote ${written.length} file(s).`);
  if (skipped.length) {
    log.dim(`Kept ${skipped.length} existing file(s) (use --force to overwrite): ${skipped.join(', ')}`);
  }
  if (evalReport.kept.length) {
    log.dim(`Eval guards kept: ${evalReport.kept.join(', ')}`);
  }
  if (evalReport.dropped.length) {
    log.dim(`Eval guards dropped (${evalReport.dropped.length}): ` + evalReport.dropped.map((d) => d.name).join(', '));
  }

  // Drafted skills/agents from the LLM pass — flagged for review, never silent.
  if (newDrafts.length) {
    log.info(
      `\n${pc.bold('Drafted for review')} (LLM-authored — keep or delete before \`apply\`):\n` +
        newDrafts.map((d) => `  • ${d}`).join('\n'),
    );
  }

  // MCP checklist — inferred servers ship commented; tell the maintainer what to set.
  if (digest.mcpServers.length) {
    const lines = digest.mcpServers.map((s) => {
      const env = s.requiredEnv.length ? ` (set: ${s.requiredEnv.join(', ')})` : '';
      return `  • ${s.name} — ${s.reason}${env}`;
    });
    log.info(
      `\n${pc.bold('Suggested MCP servers')} (commented in mcp.toml — uncomment to enable):\n` +
        lines.join('\n'),
    );
  }

  // 8. Optionally close the loop straight away (reuses the optimizer unchanged).
  if (opts.optimize) {
    log.info('');
    log.dim('Chaining `harness optimize` …');
    return runOptimize(root, {});
  }

  log.dim('Next: harness apply • harness verify • harness optimize');
  return 0;
}
