/**
 * OpenCode adapter — `sst/opencode`.
 *
 * Reads `AGENTS.md` natively. Agents and commands are markdown under
 * `.opencode/`. MCP and permissions live in a single `opencode.json` — note its
 * MCP shape is the biggest divergence in the ecosystem (command merged into one
 * array, `environment` not `env`, an `enabled` flag), handled by the transpiler.
 */
import type { Adapter, FileOutput, ProjectionResult } from './types.js';
import type { HarnessSpec } from '../config/canonical.js';
import { rootAgentsOutput, nestedAgentsOutputs, markdownDefOutputs } from './shared.js';
import { toOpenCodeMcp, projectScoped, jsonFile } from '../mcp/transpile.js';

function project(spec: HarnessSpec): ProjectionResult {
  const files: FileOutput[] = [];
  const warnings: string[] = [];

  const root = rootAgentsOutput(spec, 'opencode');
  if (root) files.push(root);
  files.push(...nestedAgentsOutputs(spec));

  files.push(...markdownDefOutputs(spec.agents, '.opencode/agent', 'subagents'));
  files.push(...markdownDefOutputs(spec.commands, '.opencode/command', 'commands'));

  if (spec.skills.length) {
    warnings.push(
      `OpenCode has no first-class skills surface; ${spec.skills.length} skill(s) not projected (use rules/commands instead).`,
    );
  }
  if (spec.outputStyles.length) {
    warnings.push(`OpenCode has no output-styles concept; ${spec.outputStyles.length} style(s) not projected.`);
  }
  if (spec.enforce.length) {
    warnings.push(`OpenCode has no hook layer; ${spec.enforce.length} enforce rule(s) are advisory only here.`);
  }

  const projectServers = projectScoped(spec.mcp);
  const nonProject = spec.mcp.filter((s) => s.scope !== 'project');
  if (nonProject.length) {
    warnings.push(
      `${nonProject.length} MCP server(s) are scope=user/local — place them in ~/.config/opencode/opencode.json: ${nonProject
        .map((s) => s.name)
        .join(', ')}.`,
    );
  }

  const p = spec.permissions;
  const includePerms = p.defaultMode !== 'ask' || p.allow.length > 0 || p.deny.length > 0 || p.ask.length > 0;
  if (includePerms && (p.allow.length || p.deny.length || p.ask.length)) {
    const n = p.allow.length + p.deny.length + p.ask.length;
    warnings.push(
      `OpenCode permission is keyed by action (edit/bash/webfetch), not tool patterns; ${n} tool rule(s) mapped only to the global default.`,
    );
  }

  if (projectServers.length || includePerms) {
    const config: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
    if (projectServers.length) config.mcp = toOpenCodeMcp(projectServers);
    if (includePerms) {
      config.permission = { edit: p.defaultMode, bash: p.defaultMode, webfetch: p.defaultMode };
    }
    files.push({
      path: 'opencode.json',
      contents: jsonFile(config),
      capability: 'mcp',
      scope: 'project',
    });
  }

  return { files, warnings };
}

export const opencode: Adapter = {
  id: 'opencode',
  title: 'OpenCode',
  homepage: 'https://opencode.ai',
  capabilities: {
    instructions: 'native',
    commands: 'native',
    subagents: 'native',
    hooks: 'none',
    mcp: 'native',
    permissions: 'native',
    outputStyles: 'none',
    skills: 'none',
    ignore: 'shim',
  },
  project,
};
