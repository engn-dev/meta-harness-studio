/**
 * Pi adapter — the `pi.dev` coding agent (Zechner/badlogic + Armin Ronacher).
 *
 * Pi reads BOTH `AGENTS.md` and `CLAUDE.md` natively (concatenated), so
 * instructions need no translation. Its core is deliberately minimal: subagents,
 * hooks and MCP are not config keys — they're TypeScript extensions. So MCP is
 * code-gen (a generated `.pi/extensions/` module), and skills go to the shared
 * `.agents/skills/` location Pi reads alongside other Agent-Skills tools.
 */
import type { Adapter, FileOutput, ProjectionResult } from './types.js';
import type { HarnessSpec, PermissionSpec } from '../config/canonical.js';
import { rootAgentsOutput, nestedAgentsOutputs, skillOutputs, markdownDefOutputs } from './shared.js';
import { toPiMcpExtension, projectScoped } from '../mcp/transpile.js';

const TRUST: Record<PermissionSpec['defaultMode'], string> = {
  allow: 'always',
  ask: 'ask',
  deny: 'never',
};

function project(spec: HarnessSpec): ProjectionResult {
  const files: FileOutput[] = [];
  const warnings: string[] = [];

  const root = rootAgentsOutput(spec, 'pi');
  if (root) files.push(root);
  files.push(...nestedAgentsOutputs(spec));

  // Skills -> the cross-tool .agents/skills/ location Pi reads natively.
  files.push(...skillOutputs(spec, '.agents/skills'));

  // Commands -> Pi prompt templates.
  files.push(...markdownDefOutputs(spec.commands, '.pi/prompts', 'commands'));

  if (spec.agents.length) {
    warnings.push(
      `Pi has no declarative subagents (extension-only); ${spec.agents.length} subagent(s) not projected — add via a .pi/extensions/ module.`,
    );
  }
  if (spec.outputStyles.length) {
    warnings.push(`Pi themes are TUI-only, not prompt styles; ${spec.outputStyles.length} output-style(s) not projected.`);
  }
  if (spec.enforce.length) {
    warnings.push(
      `Pi enforcement is via extension event handlers, not a declarative file; ${spec.enforce.length} enforce rule(s) are advisory only here.`,
    );
  }

  // MCP -> generated TypeScript extension (Pi has no MCP config key).
  const projectServers = projectScoped(spec.mcp);
  const nonProject = spec.mcp.filter((s) => s.scope !== 'project');
  if (nonProject.length) {
    warnings.push(
      `${nonProject.length} MCP server(s) are scope=user/local — Pi has no global MCP config; wire them via ~/.pi/agent/extensions/: ${nonProject
        .map((s) => s.name)
        .join(', ')}.`,
    );
  }
  if (projectServers.length) {
    files.push({
      path: '.pi/extensions/mcp-servers.ts',
      contents: toPiMcpExtension(projectServers),
      capability: 'mcp',
      scope: 'project',
      note: 'Generated Pi extension — verify the registration hook against current pi.dev docs.',
    });
  }

  // Permissions -> Pi's only knob is `defaultProjectTrust`, but Pi reads it ONLY
  // from the GLOBAL ~/.pi/agent/settings.json — a project-scoped .pi/settings.json
  // is silently ignored. Emitting one would be an inert no-op, so we degrade to a
  // warning (honest degradation) instead of writing a file that does nothing.
  if (spec.permissions.defaultMode !== 'ask') {
    warnings.push(
      `Pi project trust is global-only: set defaultProjectTrust = "${TRUST[spec.permissions.defaultMode]}" in ~/.pi/agent/settings.json. A project-scoped .pi/settings.json is ignored by Pi, so none is emitted.`,
    );
  }

  return { files, warnings };
}

export const pi: Adapter = {
  id: 'pi',
  title: 'Pi',
  homepage: 'https://pi.dev',
  capabilities: {
    instructions: 'native',
    commands: 'shim',
    subagents: 'codegen',
    hooks: 'codegen',
    mcp: 'codegen',
    permissions: 'shim',
    outputStyles: 'none',
    skills: 'native',
    ignore: 'none',
  },
  project,
};
