/**
 * Load and validate a `.harness/` directory into a single `HarnessSpec`.
 *
 * The loader is the front door of the engine: every command (`apply`, `verify`,
 * `optimize`) starts here. Validation errors are collected (not thrown) so the
 * CLI can present all of them at once — and so the optimizer can store an
 * invalid candidate with its error instead of crashing the loop.
 */
import path from 'node:path';
import matter from 'gray-matter';
import { parse as parseToml } from 'smol-toml';
import { glob } from 'tinyglobby';
import { z } from 'zod';
import {
  ManifestSchema,
  McpFileSchema,
  PermissionsSchema,
  EnforceFileSchema,
  SkillFrontmatter,
  AgentFrontmatter,
  CommandFrontmatter,
  OutputStyleFrontmatter,
} from './schema.js';
import type {
  HarnessSpec,
  Manifest,
  McpServer,
  PermissionSpec,
  EnforceRule,
  InstructionDoc,
  SkillDef,
  AgentDef,
  CommandDef,
  OutputStyleDef,
} from './canonical.js';
import { fs, pathExists, readText, listFiles, listSubdirs } from '../util/fs.js';

export interface HarnessError {
  file: string;
  message: string;
}

export interface LoadResult {
  spec?: HarnessSpec;
  errors: HarnessError[];
}

function formatZodError(file: string, err: z.ZodError): HarnessError[] {
  return err.issues.map((i) => ({
    file,
    message: i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
  }));
}

function asStringArray(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/** Read + TOML-parse a file; push a precise error and return undefined on failure. */
async function readToml(abs: string, rel: string, errors: HarnessError[]): Promise<unknown> {
  try {
    return parseToml(await readText(abs));
  } catch (e) {
    errors.push({ file: rel, message: `TOML parse error: ${(e as Error).message}` });
    return undefined;
  }
}

export async function loadHarness(root: string): Promise<LoadResult> {
  return loadFromHarnessDir(path.join(root, '.harness'), root);
}

/**
 * Validate a `.harness`-shaped directory directly. Used by the optimizer to
 * interface-validate a candidate snapshot (whose harness lives at
 * `history/<id>/harness/`, not under a `.harness/` folder).
 */
export async function loadFromHarnessDir(harnessDir: string, root: string): Promise<LoadResult> {
  const errors: HarnessError[] = [];

  const manifestPath = path.join(harnessDir, 'harness.toml');
  if (!(await pathExists(manifestPath))) {
    return {
      errors: [
        { file: '.harness/harness.toml', message: 'No harness found. Run `harness init` to scaffold one.' },
      ],
    };
  }

  // --- harness.toml ---
  let manifest: Manifest | undefined;
  const manifestRaw = await readToml(manifestPath, '.harness/harness.toml', errors);
  if (manifestRaw !== undefined) {
    const r = ManifestSchema.safeParse(manifestRaw);
    if (!r.success) {
      errors.push(...formatZodError('.harness/harness.toml', r.error));
    } else {
      manifest = {
        name: r.data.name,
        targets: r.data.targets as Manifest['targets'],
        projection: {
          mode: r.data.projection.mode,
          commitGenerated: r.data.projection.commit_generated,
          overrides: r.data.projection.overrides as Manifest['projection']['overrides'],
        },
        optimizer: {
          proposer: r.data.optimizer.proposer,
          searchSet: r.data.optimizer.search_set,
          testSet: r.data.optimizer.test_set,
          objectives: r.data.optimizer.objectives,
          maxIterations: r.data.optimizer.max_iterations,
          candidatesPerIteration: r.data.optimizer.candidates_per_iteration,
        },
      };
    }
  }

  // --- instructions: root AGENTS.md + nested instructions/<path>/AGENTS.md ---
  const instructions: InstructionDoc[] = [];
  const rootAgents = path.join(harnessDir, 'AGENTS.md');
  if (await pathExists(rootAgents)) {
    instructions.push({ path: 'AGENTS.md', scope: 'project', body: await readText(rootAgents) });
  }
  const nested = await glob('instructions/**/AGENTS.md', { cwd: harnessDir });
  for (const relFromHarness of nested.sort()) {
    const sub = path.dirname(relFromHarness).replace(/^instructions\/?/, '');
    instructions.push({
      path: sub ? `${sub}/AGENTS.md` : 'AGENTS.md',
      scope: 'project',
      body: await readText(path.join(harnessDir, relFromHarness)),
    });
  }

  // --- mcp.toml ---
  const mcp: McpServer[] = [];
  const mcpPath = path.join(harnessDir, 'mcp.toml');
  if (await pathExists(mcpPath)) {
    const raw = await readToml(mcpPath, '.harness/mcp.toml', errors);
    if (raw !== undefined) {
      const r = McpFileSchema.safeParse(raw);
      if (!r.success) errors.push(...formatZodError('.harness/mcp.toml', r.error));
      else {
        for (const [name, s] of Object.entries(r.data.servers)) {
          mcp.push({
            name,
            transport: s.transport,
            command: s.command,
            args: s.args,
            env: s.env,
            url: s.url,
            headers: s.headers,
            bearerTokenEnvVar: s.bearer_token_env_var,
            scope: s.scope,
            enabled: s.enabled,
          });
        }
      }
    }
  }

  // --- permissions.toml ---
  let permissions: PermissionSpec = {
    defaultMode: 'ask',
    allow: [],
    deny: [],
    ask: [],
    sandbox: { mode: 'workspace-write', network: false },
  };
  const permPath = path.join(harnessDir, 'permissions.toml');
  if (await pathExists(permPath)) {
    const raw = await readToml(permPath, '.harness/permissions.toml', errors);
    if (raw !== undefined) {
      const r = PermissionsSchema.safeParse(raw);
      if (!r.success) errors.push(...formatZodError('.harness/permissions.toml', r.error));
      else {
        permissions = {
          defaultMode: r.data.default_mode,
          allow: r.data.allow,
          deny: r.data.deny,
          ask: r.data.ask,
          sandbox: r.data.sandbox,
        };
      }
    }
  }

  // --- enforce.toml ---
  const enforce: EnforceRule[] = [];
  const enforcePath = path.join(harnessDir, 'enforce.toml');
  if (await pathExists(enforcePath)) {
    const raw = await readToml(enforcePath, '.harness/enforce.toml', errors);
    if (raw !== undefined) {
      const r = EnforceFileSchema.safeParse(raw);
      if (!r.success) errors.push(...formatZodError('.harness/enforce.toml', r.error));
      else {
        for (const rule of r.data.rule) {
          enforce.push({
            id: rule.id,
            description: rule.description,
            event: rule.event,
            match: rule.match,
            action: rule.action,
            run: rule.run,
            whenFiles: rule.when_files,
            message: rule.message,
          });
        }
      }
    }
  }

  // --- skills/<name>/SKILL.md ---
  const skills: SkillDef[] = [];
  const skillsDir = path.join(harnessDir, 'skills');
  for (const name of await listSubdirs(skillsDir)) {
    const dir = path.join(skillsDir, name);
    const skillFile = path.join(dir, 'SKILL.md');
    if (!(await pathExists(skillFile))) continue;
    const { data, content } = matter(await readText(skillFile));
    const fm = SkillFrontmatter.safeParse(data);
    if (!fm.success) {
      errors.push(...formatZodError(`.harness/skills/${name}/SKILL.md`, fm.error));
      continue;
    }
    const assets = (await listFiles(dir)).filter((f) => f !== 'SKILL.md');
    skills.push({
      name: fm.data.name ?? name,
      description: fm.data.description,
      body: content.trim(),
      frontmatter: data as Record<string, unknown>,
      dir,
      assets,
    });
  }

  // --- agents/<name>.md ---
  const agents: AgentDef[] = [];
  const agentsDir = path.join(harnessDir, 'agents');
  for (const file of (await listFiles(agentsDir)).filter((f) => f.endsWith('.md'))) {
    const base = file.replace(/\.md$/, '');
    const { data, content } = matter(await readText(path.join(agentsDir, file)));
    const fm = AgentFrontmatter.safeParse(data);
    if (!fm.success) {
      errors.push(...formatZodError(`.harness/agents/${file}`, fm.error));
      continue;
    }
    agents.push({
      name: fm.data.name ?? base,
      description: fm.data.description,
      body: content.trim(),
      tools: asStringArray(fm.data.tools),
      model: fm.data.model,
      frontmatter: data as Record<string, unknown>,
    });
  }

  // --- commands/<name>.md ---
  const commands: CommandDef[] = [];
  const commandsDir = path.join(harnessDir, 'commands');
  for (const file of (await listFiles(commandsDir)).filter((f) => f.endsWith('.md'))) {
    const base = file.replace(/\.md$/, '');
    const { data, content } = matter(await readText(path.join(commandsDir, file)));
    const fm = CommandFrontmatter.safeParse(data);
    if (!fm.success) {
      errors.push(...formatZodError(`.harness/commands/${file}`, fm.error));
      continue;
    }
    commands.push({
      name: fm.data.name ?? base,
      description: fm.data.description,
      argumentHint: fm.data['argument-hint'],
      body: content.trim(),
      frontmatter: data as Record<string, unknown>,
    });
  }

  // --- output-styles/<name>.md ---
  const outputStyles: OutputStyleDef[] = [];
  const stylesDir = path.join(harnessDir, 'output-styles');
  for (const file of (await listFiles(stylesDir)).filter((f) => f.endsWith('.md'))) {
    const base = file.replace(/\.md$/, '');
    const { data, content } = matter(await readText(path.join(stylesDir, file)));
    const fm = OutputStyleFrontmatter.safeParse(data);
    if (!fm.success) {
      errors.push(...formatZodError(`.harness/output-styles/${file}`, fm.error));
      continue;
    }
    outputStyles.push({
      name: fm.data.name ?? base,
      description: fm.data.description,
      body: content.trim(),
      frontmatter: data as Record<string, unknown>,
    });
  }

  if (!manifest) return { errors };

  const spec: HarnessSpec = {
    root,
    harnessDir,
    manifest,
    instructions,
    mcp,
    permissions,
    enforce,
    skills,
    agents,
    commands,
    outputStyles,
  };

  return { spec, errors };
}

export { fs };
