/**
 * Disk writer + drift differ.
 *
 * Both `apply` (write) and `verify` (drift check) compute the *same* expected
 * bytes for an output, so they can never disagree about what "correct" means.
 * For instruction files we compare effective content (following a symlink),
 * which means a symlinked and a copied AGENTS.md both count as in-sync.
 */
import path from 'node:path';
import { fs, ensureDir, pathExists } from '../util/fs.js';
import { linkOrCopy } from '../util/symlink.js';
import type { ResolvedOutput } from './project.js';

export type WriteAction = 'created' | 'updated' | 'unchanged' | 'symlinked' | 'copied';

export interface WriteResult {
  path: string;
  action: WriteAction;
}

export type DriftStatus = 'match' | 'changed' | 'missing';

export interface DriftResult {
  path: string;
  status: DriftStatus;
}

async function expectedBytes(output: ResolvedOutput, outRoot: string): Promise<Buffer> {
  if (output.contents !== undefined) return Buffer.from(output.contents, 'utf8');
  if (output.copyFrom !== undefined) return fs.readFile(output.copyFrom);
  if (output.symlinkTo !== undefined) return fs.readFile(path.join(outRoot, output.symlinkTo));
  return Buffer.alloc(0);
}

async function actualBytes(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs); // follows symlinks
  } catch {
    return null;
  }
}

export async function diffOutputs(
  outputs: ResolvedOutput[],
  outRoot: string,
): Promise<DriftResult[]> {
  const results: DriftResult[] = [];
  for (const output of outputs) {
    const abs = path.join(outRoot, output.path);
    const expected = await expectedBytes(output, outRoot);
    const actual = await actualBytes(abs);
    if (actual === null) results.push({ path: output.path, status: 'missing' });
    else if (actual.equals(expected)) results.push({ path: output.path, status: 'match' });
    else results.push({ path: output.path, status: 'changed' });
  }
  return results;
}

export async function writeOutputs(
  outputs: ResolvedOutput[],
  outRoot: string,
  opts: { dryRun?: boolean } = {},
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const output of outputs) {
    const abs = path.join(outRoot, output.path);

    // Symlink outputs: create a relative link (or copy-fallback on Windows).
    if (output.symlinkTo !== undefined) {
      if (opts.dryRun) {
        results.push({ path: output.path, action: 'symlinked' });
        continue;
      }
      const target = path.join(outRoot, output.symlinkTo);
      const r = await linkOrCopy(abs, target);
      results.push({ path: output.path, action: r === 'symlinked' ? 'symlinked' : 'copied' });
      continue;
    }

    const expected = await expectedBytes(output, outRoot);
    const actual = await actualBytes(abs);
    const action: WriteAction = actual === null ? 'created' : actual.equals(expected) ? 'unchanged' : 'updated';

    if (!opts.dryRun && action !== 'unchanged') {
      await ensureDir(path.dirname(abs));
      await fs.writeFile(abs, expected);
    }
    results.push({ path: output.path, action });
  }

  return results;
}

export { pathExists };
