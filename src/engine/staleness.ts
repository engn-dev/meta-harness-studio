/**
 * Semantic staleness detection.
 *
 * Research found 46% of repos suffer "rule drift" — instructions pointing at
 * scripts that were renamed or removed. Byte-level sync can't catch this. We
 * scan instructions, commands and enforce `run` commands for referenced npm
 * scripts and verify they still exist in package.json.
 */
import path from 'node:path';
import type { HarnessSpec } from '../config/canonical.js';
import { readTextOr } from '../util/fs.js';

export interface StaleRef {
  reference: string;
  source: string;
  reason: string;
}

// Require an explicit `run` for every package manager. Bare `pnpm <x>` / `yarn <x>`
// is ambiguous with builtins (`pnpm install`, `yarn add`) and would mis-flag them
// as missing scripts — under-detecting bare shorthand is safer than failing CI on
// valid text.
const SCRIPT_RE = /\b(?:npm|pnpm|yarn|bun) run\s+([a-zA-Z0-9:_-]+)/g;

function collectScriptRefs(text: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(text)) !== null) {
    if (m[1]) refs.push(m[1]);
  }
  return refs;
}

export async function detectStaleScripts(spec: HarnessSpec): Promise<StaleRef[]> {
  const pkgRaw = await readTextOr(path.join(spec.root, 'package.json'));
  if (!pkgRaw) return []; // can't verify without a package.json

  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(pkgRaw).scripts as Record<string, unknown>) ?? {};
  } catch {
    return [];
  }
  const defined = new Set(Object.keys(scripts));

  const sources: Array<{ source: string; text: string }> = [];
  for (const doc of spec.instructions) sources.push({ source: doc.path, text: doc.body });
  for (const cmd of spec.commands) sources.push({ source: `commands/${cmd.name}.md`, text: cmd.body });
  for (const rule of spec.enforce) {
    if (rule.run) sources.push({ source: `enforce/${rule.id}`, text: rule.run });
  }

  const stale: StaleRef[] = [];
  const seen = new Set<string>();
  for (const { source, text } of sources) {
    for (const ref of collectScriptRefs(text)) {
      if (defined.has(ref)) continue;
      const key = `${source}::${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stale.push({
        reference: ref,
        source,
        reason: `npm script '${ref}' is referenced but not defined in package.json`,
      });
    }
  }
  return stale;
}
