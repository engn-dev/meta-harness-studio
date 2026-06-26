/**
 * Enforcement compiler.
 *
 * `enforce.toml` invariants are "must-happen" rules. The research is blunt about
 * this: static instructions guarantee *consistency, not behavior* — the only
 * deterministic enforcement layer that exists in production is Claude Code's
 * hooks + permission deny rules. So we compile invariants into real Claude Code
 * artifacts, and degrade to advisory notes for targets without a hook layer.
 */
import type { EnforceRule, EnforceEvent } from '../config/canonical.js';

export interface ClaudeHookHandler {
  type: 'command';
  command: string;
}
export interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookHandler[];
}
export type ClaudeHooks = Record<string, ClaudeHookMatcher[]>;

export interface ClaudeEnforcement {
  hooks: ClaudeHooks;
  /** Extra `permissions.deny` rules, e.g. `Read(./.env*)`. */
  deny: string[];
  warnings: string[];
}

const EVENT_MAP: Record<EnforceEvent, string> = {
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  'user-prompt': 'UserPromptSubmit',
  stop: 'Stop',
  'session-start': 'SessionStart',
};

function toolNames(match: string): string[] {
  if (match === '*' || match.trim() === '') return [];
  return match
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Single-quote escape for embedding a string in a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function compileClaudeEnforcement(enforce: EnforceRule[]): ClaudeEnforcement {
  const hooks: ClaudeHooks = {};
  const deny: string[] = [];
  const warnings: string[] = [];

  const add = (event: string, matcher: string | undefined, command: string): void => {
    (hooks[event] ??= []).push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command }],
    });
  };

  for (const r of enforce) {
    const event = EVENT_MAP[r.event];
    const tools = toolNames(r.match);
    const matcher = tools.length ? tools.join('|') : undefined;
    const message = r.message || r.description || `Blocked by harness rule '${r.id}'`;

    if (r.action === 'deny') {
      if (r.event !== 'pre-tool') {
        warnings.push(
          `enforce '${r.id}': action=deny only maps cleanly to a pre-tool gate; emitted a blocking ${event} hook instead.`,
        );
        add(event, matcher, `printf '%s\\n' ${shq(message)} 1>&2; exit 2`);
        continue;
      }
      if (tools.length === 0) {
        warnings.push(
          `enforce '${r.id}': deny with match='*' can't be a precise permission rule; emitted a blocking PreToolUse hook.`,
        );
        add('PreToolUse', undefined, `printf '%s\\n' ${shq(message)} 1>&2; exit 2`);
        continue;
      }
      for (const tool of tools) {
        if (r.whenFiles.length) {
          for (const g of r.whenFiles) deny.push(`${tool}(${g})`);
        } else {
          deny.push(tool);
        }
      }
    } else if (r.action === 'warn') {
      add(event, matcher, `printf '%s\\n' ${shq(message)} 1>&2`);
    } else {
      // action === 'run'
      add(event, matcher, r.run as string);
      if (r.whenFiles.length) {
        warnings.push(
          `enforce '${r.id}': when_files scoping isn't expressible in a hook matcher — guard inside the command \`${r.run}\` if it must only run for ${r.whenFiles.join(', ')}.`,
        );
      }
    }
  }

  return { hooks, deny, warnings };
}
