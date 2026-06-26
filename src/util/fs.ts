import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

export async function readTextOr(p: string, fallback = ''): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return fallback;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Write a file, creating parent directories as needed. */
export async function writeText(p: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, contents, 'utf8');
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** Direct child directories of `dir` (names, not full paths). */
export async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/** Recursively copy a directory tree. */
export async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await ensureDir(path.dirname(d));
      await fs.copyFile(s, d);
    }
  }
}

export { fs };
