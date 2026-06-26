/**
 * Projection engine: run every enabled adapter, then reconcile.
 *
 * Multiple targets legitimately want the same file (every tool reads `AGENTS.md`
 * at the project root). We dedupe identical outputs into one resolved file and
 * record which targets contributed it. If two targets want the *same path* with
 * *different* content, that's a real conflict and we report it rather than
 * letting last-writer-wins corrupt the tree.
 */
import type { HarnessSpec, TargetId } from '../config/canonical.js';
import type { Capability } from '../targets/types.js';
import { enabledAdapters } from '../targets/registry.js';

export interface ResolvedOutput {
  path: string;
  contents?: string;
  symlinkTo?: string;
  copyFrom?: string;
  capability: Capability;
  scope: 'project' | 'user';
  note?: string;
  /** Targets that asked for this exact file. */
  targets: TargetId[];
}

export interface TargetWarning {
  target: TargetId;
  message: string;
}

export interface Conflict {
  path: string;
  /** Each variant: which target produced it and a short signature. */
  variants: Array<{ target: TargetId; signature: string }>;
}

export interface ProjectionPlan {
  outputs: ResolvedOutput[];
  warnings: TargetWarning[];
  conflicts: Conflict[];
}

function signature(o: { contents?: string; symlinkTo?: string; copyFrom?: string }): string {
  if (o.symlinkTo !== undefined) return `symlink:${o.symlinkTo}`;
  if (o.copyFrom !== undefined) return `copy:${o.copyFrom}`;
  return `content:${o.contents ?? ''}`;
}

export function projectAll(spec: HarnessSpec): ProjectionPlan {
  const warnings: TargetWarning[] = [];
  const byPath = new Map<
    string,
    { base: Omit<ResolvedOutput, 'targets'>; bySig: Map<string, TargetId[]> }
  >();

  for (const adapter of enabledAdapters(spec.manifest.targets)) {
    const result = adapter.project(spec);
    for (const w of result.warnings) warnings.push({ target: adapter.id, message: w });
    for (const f of result.files) {
      const sig = signature(f);
      const existing = byPath.get(f.path);
      if (!existing) {
        byPath.set(f.path, {
          base: {
            path: f.path,
            contents: f.contents,
            symlinkTo: f.symlinkTo,
            copyFrom: f.copyFrom,
            capability: f.capability,
            scope: f.scope,
            note: f.note,
          },
          bySig: new Map([[sig, [adapter.id]]]),
        });
      } else {
        const list = existing.bySig.get(sig);
        if (list) list.push(adapter.id);
        else existing.bySig.set(sig, [adapter.id]);
      }
    }
  }

  const outputs: ResolvedOutput[] = [];
  const conflicts: Conflict[] = [];
  for (const [path, { base, bySig }] of byPath) {
    if (bySig.size > 1) {
      const variants: Conflict['variants'] = [];
      for (const [sig, targets] of bySig) {
        for (const t of targets) variants.push({ target: t, signature: sig.slice(0, 60) });
      }
      conflicts.push({ path, variants });
      continue;
    }
    const targets = [...bySig.values()][0] ?? [];
    outputs.push({ ...base, targets });
  }

  outputs.sort((a, b) => a.path.localeCompare(b.path));
  return { outputs, warnings, conflicts };
}
