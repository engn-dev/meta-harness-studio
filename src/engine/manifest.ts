/**
 * Generated-output manifest + orphan reconciliation.
 *
 * `apply` writes only the files the *current* spec projects. Without a record of
 * what a previous apply produced, a file generated for a now-removed target (drop
 * `opencode` from harness.toml) or a deleted artifact (`commands/review.md`) lingers
 * on disk — the exact drift this tool exists to eliminate, and `verify` would
 * report it "in sync" because it only inspects current outputs.
 *
 * So every apply records the relative paths it wrote to `.harness/.generated/
 * apply-manifest.json`. The next apply diffs that against the new plan and deletes
 * the orphans (pruning now-empty parent dirs); `verify` loads the same manifest and
 * flags any still-present orphan as a counted problem.
 */
import path from 'node:path';
import { fs, pathExists, readTextOr } from '../util/fs.js';

interface ApplyManifest {
  version: 1;
  generated: string[];
}

function manifestPath(harnessDir: string): string {
  return path.join(harnessDir, '.generated', 'apply-manifest.json');
}

/** Relative paths recorded by the previous apply (empty if none). */
export async function readManifest(harnessDir: string): Promise<string[]> {
  const raw = await readTextOr(manifestPath(harnessDir));
  if (!raw) return [];
  try {
    const m = JSON.parse(raw) as ApplyManifest;
    return Array.isArray(m.generated) ? m.generated : [];
  } catch {
    return [];
  }
}

export async function writeManifest(harnessDir: string, generated: string[]): Promise<void> {
  const p = manifestPath(harnessDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const m: ApplyManifest = { version: 1, generated: [...generated].sort() };
  await fs.writeFile(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

/** Paths the previous apply created that the current plan no longer emits. */
export function computeOrphans(prior: string[], current: string[]): string[] {
  const keep = new Set(current);
  return prior.filter((p) => !keep.has(p)).sort();
}

/** Of the manifest's orphans, the subset that still exists on disk. */
export async function existingOrphans(
  harnessDir: string,
  current: string[],
  outRoot: string,
): Promise<string[]> {
  const prior = await readManifest(harnessDir);
  const orphans = computeOrphans(prior, current);
  const present: string[] = [];
  for (const rel of orphans) {
    if (await pathExists(path.join(outRoot, rel))) present.push(rel);
  }
  return present;
}

/** Delete an orphaned file and prune any parent dirs left empty (bounded by outRoot). */
export async function pruneOrphans(orphans: string[], outRoot: string): Promise<void> {
  for (const rel of orphans) {
    const abs = path.join(outRoot, rel);
    await fs.rm(abs, { force: true });
    // Walk up removing now-empty directories, never crossing above outRoot.
    let dir = path.dirname(abs);
    while (dir.startsWith(outRoot) && dir !== outRoot) {
      try {
        await fs.rmdir(dir); // throws if not empty — that's the stop condition
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}
