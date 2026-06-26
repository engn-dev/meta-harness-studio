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

/** package.json `scripts` keys at `dir`, or null if there's no package.json there. */
async function scriptsAt(dir: string): Promise<Set<string> | null> {
  const raw = await readTextOr(path.join(dir, 'package.json'));
  if (!raw) return null;
  try {
    const scripts = (JSON.parse(raw).scripts as Record<string, unknown>) ?? {};
    return new Set(Object.keys(scripts));
  } catch {
    return null;
  }
}

export async function detectStaleScripts(spec: HarnessSpec): Promise<StaleRef[]> {
  // Resolve scripts per source by walking from the source's directory UP to the
  // project root, unioning every package.json found (monorepo nearest-wins): a
  // nested AGENTS.md may reference a script defined in its own package.json, the
  // root's, or any level between — flagging it stale only if none define it.
  const cache = new Map<string, Set<string> | null>();
  const dirScripts = async (dir: string): Promise<Set<string> | null> => {
    if (!cache.has(dir)) cache.set(dir, await scriptsAt(dir));
    return cache.get(dir) ?? null;
  };
  const definedFor = async (sourceRel: string): Promise<Set<string> | null> => {
    let rel = path.dirname(sourceRel);
    if (rel === '.') rel = '';
    const union = new Set<string>();
    let found = false;
    // From the source dir up to (and including) the root.
    for (let cur = rel; ; cur = path.dirname(cur)) {
      const scripts = await dirScripts(path.join(spec.root, cur));
      if (scripts) {
        found = true;
        for (const s of scripts) union.add(s);
      }
      if (cur === '' || cur === '.') break;
    }
    return found ? union : null;
  };

  const sources: Array<{ source: string; text: string }> = [];
  for (const doc of spec.instructions) sources.push({ source: doc.path, text: doc.body });
  // Commands and enforce rules are root-scoped surfaces.
  for (const cmd of spec.commands) sources.push({ source: `commands/${cmd.name}.md`, text: cmd.body });
  for (const rule of spec.enforce) {
    if (rule.run) sources.push({ source: `enforce/${rule.id}`, text: rule.run });
  }

  const stale: StaleRef[] = [];
  const seen = new Set<string>();
  for (const { source, text } of sources) {
    const refs = collectScriptRefs(text);
    if (!refs.length) continue;
    // commands/enforce have no real directory — resolve against the root.
    const lookupKey = source.startsWith('commands/') || source.startsWith('enforce/') ? 'AGENTS.md' : source;
    const defined = await definedFor(lookupKey);
    if (!defined) continue; // can't verify without a package.json on the path
    for (const ref of refs) {
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
