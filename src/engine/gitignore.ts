/**
 * Managed `.gitignore` block.
 *
 * The optimizer's `history/` (raw, possibly large/sensitive traces) and the
 * internal `.harness/.generated/` scratch are local by default. When
 * `[projection] commit_generated = false`, the per-tool config we emit should be
 * ignored too. We keep all of this in a single clearly-marked managed block so the
 * `commit_generated` knob actually does something and a fresh `init` honors the
 * documented "history/ gitignored by default" — without clobbering a user's own
 * ignore rules.
 */
import path from 'node:path';
import type { HarnessSpec } from '../config/canonical.js';
import { readTextOr, writeText } from '../util/fs.js';

const BEGIN = '# >>> meta-harness-studio (managed) >>>';
const END = '# <<< meta-harness-studio (managed) <<<';

/** The lines the managed block should contain for this spec + generated output set. */
export function managedLines(spec: HarnessSpec, generatedPaths: string[]): string[] {
  const lines = [
    '# Optimizer run artifacts and internal scratch are local by default.',
    '.harness/history/',
    '.harness/.generated/',
  ];
  if (!spec.manifest.projection.commitGenerated) {
    lines.push('# commit_generated = false → generated tool config is ignored too:');
    for (const p of [...new Set(generatedPaths)].sort()) {
      if (p.startsWith('.harness/')) continue; // already covered above
      lines.push(`/${p}`);
    }
  }
  return lines;
}

function renderBlock(lines: string[]): string {
  return [BEGIN, ...lines, END].join('\n');
}

/**
 * Insert or replace the managed block in `<root>/.gitignore`, preserving the rest.
 * Returns true if the file content changed.
 */
export async function syncGitignore(
  root: string,
  spec: HarnessSpec,
  generatedPaths: string[],
): Promise<boolean> {
  const file = path.join(root, '.gitignore');
  const existing = await readTextOr(file);
  const block = renderBlock(managedLines(spec, generatedPaths));

  let next: string;
  const begin = existing.indexOf(BEGIN);
  if (begin !== -1) {
    const endIdx = existing.indexOf(END, begin);
    const after = endIdx !== -1 ? existing.slice(endIdx + END.length) : '';
    next = existing.slice(0, begin) + block + after;
  } else if (existing.trim()) {
    next = existing.replace(/\n*$/, '\n') + '\n' + block + '\n';
  } else {
    next = block + '\n';
  }

  if (next === existing) return false;
  await writeText(file, next);
  return true;
}
