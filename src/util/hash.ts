import { createHash } from 'node:crypto';
import path from 'node:path';
import { fs, listDir } from './fs.js';

export function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Stable content hash of a directory tree (sorted relative paths + file bytes).
 * Used to dedupe identical harness variants so the optimizer never re-evaluates
 * the same config twice.
 *
 * `ignore` entries are matched only at the TOP LEVEL (e.g. `history`, `.generated`):
 * a nested file or directory that happens to share one of those names still
 * contributes to the hash, so two genuinely different variants never collide.
 */
export async function hashDir(dir: string, ignore: string[] = []): Promise<string> {
  const h = createHash('sha256');
  const walk = async (cur: string, rel: string): Promise<void> => {
    const names = (await listDir(cur)).sort();
    for (const name of names) {
      if (rel === '' && ignore.includes(name)) continue;
      const abs = path.join(cur, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        await walk(abs, relPath);
      } else if (stat.isFile()) {
        h.update(relPath);
        h.update('\0');
        h.update(await fs.readFile(abs));
        h.update('\0');
      }
    }
  };
  await walk(dir, '');
  return h.digest('hex').slice(0, 16);
}
