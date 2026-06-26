/**
 * Lightweight, dependency-free file-importance ranking (Phase 3).
 *
 * The architecture section is only as useful as the files it features, and
 * manifest entrypoints miss the modules a repo actually revolves around. Rather
 * than pull in tree-sitter + per-language grammars (the paper's heavier repo-map),
 * we approximate centrality cheaply: count how many other source files import each
 * module, and surface the most-referenced ones. JS/TS only — where a regex over
 * import specifiers is reliable — and a silent no-op elsewhere, so keyPaths can
 * only ever gain signal, never regress.
 */
import path from 'node:path';
import { glob } from 'tinyglobby';
import { readTextOr } from '../util/fs.js';

const SRC_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/vendor/**',
  '**/target/**',
  '**/out/**',
  '**/.next/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.d.ts',
];
/** Above this, skip ranking — the read cost isn't worth it for a one-shot author. */
const MAX_FILES = 800;
const MAX_BYTES = 50_000;
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** A module must be imported at least this many times to count as "central". */
const MIN_INBOUND = 2;

// `import … from 'x'` / `export … from 'x'` / `require('x')` / `import('x')` / `import 'x'`.
const IMPORT_RE =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Resolve a relative import specifier to a repo-relative file in `fileSet`, if any. */
function resolveImport(importerRel: string, spec: string, fileSet: Set<string>): string | undefined {
  const dir = path.posix.dirname(toPosix(importerRel));
  // Drop a bundler query/fragment (`./worker?worker`, `./icon.svg?url`, `#frag`),
  // then strip any source extension the author wrote (`./x.js` may be `x.ts` on disk).
  const cleaned = spec.replace(/[?#].*$/, '');
  const base = path.posix
    .normalize(path.posix.join(dir, cleaned))
    .replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  for (const ext of RESOLVE_EXTS) {
    if (fileSet.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    const idx = path.posix.join(base, 'index' + ext);
    if (fileSet.has(idx)) return idx;
  }
  return undefined;
}

/**
 * Return the most-imported source files (repo-relative, posix), highest first,
 * capped at `limit`. Empty for non-JS/TS repos or when nothing clears MIN_INBOUND.
 */
export async function rankImportantFiles(root: string, limit = 4): Promise<string[]> {
  let files: string[];
  try {
    files = await glob(SRC_GLOB, { cwd: root, ignore: IGNORE, onlyFiles: true, dot: false });
  } catch {
    return [];
  }
  if (files.length < 3 || files.length > MAX_FILES) return [];

  const fileSet = new Set(files.map(toPosix));
  const inbound = new Map<string, number>();

  for (const rel of files) {
    const text = (await readTextOr(path.join(root, rel))).slice(0, MAX_BYTES);
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || !spec.startsWith('.')) continue; // package imports aren't repo files
      const target = resolveImport(rel, spec, fileSet);
      if (target && target !== toPosix(rel)) {
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
  }

  return [...inbound.entries()]
    .filter(([, n]) => n >= MIN_INBOUND)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([rel]) => rel);
}
