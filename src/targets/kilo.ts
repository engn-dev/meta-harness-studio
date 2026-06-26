/**
 * Kilo Code adapter — `Kilo-Org/kilocode` (kilo.ai), a Roo + Cline superset.
 *
 * Reads `AGENTS.md` (must be UPPERCASE — our canonical path already is). Commands
 * map to workflows, subagents to Kilo "Agents". Unlike Cline, MCP is a
 * project-local file (`.kilocode/mcp.json`), so it's written directly.
 */
import type { Adapter, FileOutput, ProjectionResult } from './types.js';
import type { HarnessSpec } from '../config/canonical.js';
import { rootAgentsOutput, nestedAgentsOutputs, markdownDefOutputs } from './shared.js';
import { toRooStyleMcp, projectScoped, jsonFile } from '../mcp/transpile.js';

function project(spec: HarnessSpec): ProjectionResult {
  const files: FileOutput[] = [];
  const warnings: string[] = [];

  const root = rootAgentsOutput(spec, 'kilo');
  if (root) files.push(root);
  files.push(...nestedAgentsOutputs(spec));

  files.push(...markdownDefOutputs(spec.commands, '.kilocode/workflows', 'commands'));
  files.push(...markdownDefOutputs(spec.agents, '.kilo/agents', 'subagents'));

  if (spec.skills.length) {
    warnings.push(
      `Kilo Code's skills path varies by version; ${spec.skills.length} skill(s) not projected — add them via the Kilo UI or .agents/skills/.`,
    );
  }
  if (spec.outputStyles.length) {
    warnings.push(`Kilo Code has no output-styles concept; ${spec.outputStyles.length} style(s) not projected.`);
  }
  if (spec.enforce.length) {
    warnings.push(`Kilo Code has no portable hook layer; ${spec.enforce.length} enforce rule(s) are advisory only here.`);
  }

  const projectServers = projectScoped(spec.mcp);
  const nonProject = spec.mcp.filter((s) => s.scope !== 'project');
  if (nonProject.length) {
    warnings.push(
      `${nonProject.length} MCP server(s) are scope=user/local — Kilo's .kilocode/mcp.json is project-local; add them via the Kilo global MCP settings: ${nonProject
        .map((s) => s.name)
        .join(', ')}.`,
    );
  }
  if (projectServers.length) {
    files.push({
      path: '.kilocode/mcp.json',
      contents: jsonFile(toRooStyleMcp(projectServers)),
      capability: 'mcp',
      scope: 'project',
    });
  }

  return { files, warnings };
}

export const kilo: Adapter = {
  id: 'kilo',
  title: 'Kilo Code',
  homepage: 'https://kilo.ai',
  capabilities: {
    instructions: 'native',
    commands: 'native',
    subagents: 'native',
    hooks: 'none',
    mcp: 'native',
    permissions: 'shim',
    outputStyles: 'none',
    skills: 'shim',
    ignore: 'shim',
  },
  project,
};
