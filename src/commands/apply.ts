/**
 * `harness apply` — validate, project the canonical spec onto every enabled
 * target, and write the result (or preview it with --dry-run).
 */
import { requireSpec } from './common.js';
import { projectAll } from '../engine/project.js';
import { writeOutputs } from '../engine/write.js';
import { getAdapter } from '../targets/registry.js';
import { log, pc } from '../util/log.js';

export interface ApplyOptions {
  dryRun?: boolean;
  outRoot?: string;
}

export async function runApply(root: string, opts: ApplyOptions = {}): Promise<number> {
  const { spec } = await requireSpec(root, { strict: true });
  const plan = projectAll(spec);
  const outRoot = opts.outRoot ?? spec.root;

  if (plan.conflicts.length) {
    log.error('Projection conflicts — two targets want the same path with different content:');
    for (const c of plan.conflicts) {
      log.error(`  ${pc.bold(c.path)}`);
      for (const v of c.variants) log.dim(`    ${v.target}: ${v.signature}`);
    }
    return 1;
  }

  log.heading(
    `${opts.dryRun ? 'Planning' : 'Applying'} harness "${spec.manifest.name}" → ${spec.manifest.targets
      .map((t) => getAdapter(t).title)
      .join(', ')}`,
  );

  const results = await writeOutputs(plan.outputs, outRoot, { dryRun: opts.dryRun });
  const byPath = new Map(plan.outputs.map((o) => [o.path, o]));

  let changed = 0;
  for (const r of results) {
    const o = byPath.get(r.path);
    const tags = o ? pc.dim(`[${o.targets.join(', ')}]`) : '';
    const verb =
      r.action === 'created'
        ? pc.green('create')
        : r.action === 'updated'
          ? pc.yellow('update')
          : r.action === 'symlinked'
            ? pc.cyan('symlink')
            : r.action === 'copied'
              ? pc.cyan('copy')
              : pc.dim('unchanged');
    if (r.action !== 'unchanged') changed++;
    log.info(`  ${verb}  ${r.path} ${tags}`);
    if (o?.note) log.dim(`         ↳ ${o.note}`);
  }

  if (plan.warnings.length) {
    log.heading('Capability notes (graceful degradation per target)');
    for (const w of plan.warnings) {
      log.warn(`${pc.dim(`[${w.target}]`)} ${w.message}`);
    }
  }

  log.heading(
    opts.dryRun
      ? `Plan: ${results.length} file(s), ${changed} would change. Re-run without --dry-run to write.`
      : `Done: ${results.length} file(s), ${changed} written, ${results.length - changed} unchanged.`,
  );
  return 0;
}
