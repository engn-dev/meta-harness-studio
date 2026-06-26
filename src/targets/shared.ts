/**
 * Reusable projection builders shared across adapters.
 *
 * Many tools want the same artifact at the same path (every target reads
 * `AGENTS.md` at the project root). Each adapter still declares what *it* needs;
 * the projection engine dedupes identical paths. These helpers keep that
 * declaration short and consistent.
 */
import path from 'node:path';
import matter from 'gray-matter';
import type { HarnessSpec, ProjectionMode, TargetId } from '../config/canonical.js';
import type { Capability, FileOutput } from './types.js';

export function modeFor(spec: HarnessSpec, target: TargetId): ProjectionMode {
  return spec.manifest.projection.overrides[target] ?? spec.manifest.projection.mode;
}

/** The root AGENTS.md, as a symlink to canonical (symlink mode) or a copy (generate mode). */
export function rootAgentsOutput(spec: HarnessSpec, target: TargetId): FileOutput | null {
  const root = spec.instructions.find((d) => d.path === 'AGENTS.md');
  if (!root) return null;
  if (modeFor(spec, target) === 'symlink') {
    return {
      path: 'AGENTS.md',
      symlinkTo: '.harness/AGENTS.md',
      capability: 'instructions',
      scope: 'project',
    };
  }
  return {
    path: 'AGENTS.md',
    contents: ensureTrailingNewline(root.body),
    capability: 'instructions',
    scope: 'project',
  };
}

/** Nested per-package AGENTS.md files (monorepo nearest-wins preserved). */
export function nestedAgentsOutputs(spec: HarnessSpec): FileOutput[] {
  return spec.instructions
    .filter((d) => d.path !== 'AGENTS.md')
    .map((d) => ({
      path: d.path,
      contents: ensureTrailingNewline(d.body),
      capability: 'instructions' as Capability,
      scope: 'project' as const,
    }));
}

/** Emit skills under `baseRel/<name>/SKILL.md` (+ copied assets). */
export function skillOutputs(
  spec: HarnessSpec,
  baseRel: string,
  capability: Capability = 'skills',
): FileOutput[] {
  const out: FileOutput[] = [];
  for (const skill of spec.skills) {
    out.push({
      path: `${baseRel}/${skill.name}/SKILL.md`,
      contents: matter.stringify('\n' + skill.body + '\n', skill.frontmatter),
      capability,
      scope: 'project',
    });
    for (const asset of skill.assets) {
      out.push({
        path: `${baseRel}/${skill.name}/${asset}`,
        copyFrom: path.join(skill.dir, asset),
        capability,
        scope: 'project',
      });
    }
  }
  return out;
}

/** Emit markdown+frontmatter defs (agents/commands/output-styles) under `baseRel/<name>.md`. */
export function markdownDefOutputs(
  defs: Array<{ name: string; body: string; frontmatter: Record<string, unknown> }>,
  baseRel: string,
  capability: Capability,
): FileOutput[] {
  return defs.map((d) => ({
    path: `${baseRel}/${d.name}.md`,
    contents: matter.stringify('\n' + d.body + '\n', d.frontmatter),
    capability,
    scope: 'project' as const,
  }));
}

export function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

/** Format a canonical permission rule as a Claude-style `Tool(pattern)` string. */
export function permRuleString(r: { tool: string; pattern?: string }): string {
  return r.pattern ? `${r.tool}(${r.pattern})` : r.tool;
}
