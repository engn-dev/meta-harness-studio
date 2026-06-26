import path from 'node:path';
import { fs, ensureDir, pathExists } from './fs.js';

export type LinkResult = 'symlinked' | 'copied-fallback';

/**
 * Create a relative symlink at `linkPath` pointing to `targetPath`.
 *
 * Windows symlinks need elevation/Developer Mode, so on failure we fall back to
 * a byte copy and report it — the caller can warn the user that the link is a
 * snapshot, not a live mirror. This is why the projection engine prefers
 * generating a `CLAUDE.md` import shim over symlinking it (Windows-safe).
 */
export async function linkOrCopy(linkPath: string, targetPath: string): Promise<LinkResult> {
  await ensureDir(path.dirname(linkPath));
  if (await pathExists(linkPath)) {
    await fs.rm(linkPath, { force: true });
  }
  const rel = path.relative(path.dirname(linkPath), targetPath);
  try {
    await fs.symlink(rel, linkPath);
    return 'symlinked';
  } catch {
    await fs.copyFile(targetPath, linkPath);
    return 'copied-fallback';
  }
}
