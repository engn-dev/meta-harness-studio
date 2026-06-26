/**
 * The adapter registry — data-driven so adding/removing a target is one edit
 * here, not an engine rewrite. (Targets churn fast: Gemini CLI was retired
 * 2026-06-18; Antigravity/Kiro forked into IDE+CLI. A registry absorbs that.)
 */
import type { Adapter } from './types.js';
import type { TargetId } from '../config/canonical.js';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { opencode } from './opencode.js';
import { cline } from './cline.js';
import { kilo } from './kilo.js';
import { pi } from './pi.js';

export const REGISTRY: Record<TargetId, Adapter> = {
  'claude-code': claudeCode,
  codex,
  opencode,
  cline,
  kilo,
  pi,
};

export function getAdapter(id: TargetId): Adapter {
  return REGISTRY[id];
}

export function allAdapters(): Adapter[] {
  return Object.values(REGISTRY);
}

export function enabledAdapters(targets: TargetId[]): Adapter[] {
  return targets.map((t) => REGISTRY[t]);
}
