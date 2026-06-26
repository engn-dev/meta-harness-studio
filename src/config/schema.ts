/**
 * Zod schemas for every file in `.harness/`.
 *
 * These are the *interface-validation gate* from the Meta-Harness paper: a cheap
 * structural check that runs before any expensive projection or evaluation. A
 * candidate harness that does not parse here is rejected with a precise message
 * instead of producing broken tool config downstream.
 */
import { z } from 'zod';
import { ALL_TARGETS } from './canonical.js';

const TargetId = z.enum(ALL_TARGETS as [string, ...string[]]);
const ProjectionMode = z.enum(['generate', 'symlink']);

export const ManifestSchema = z
  .object({
    name: z.string().min(1, 'harness.toml: `name` is required'),
    targets: z.array(TargetId).nonempty('harness.toml: enable at least one target'),
    projection: z
      .object({
        mode: ProjectionMode.default('generate'),
        commit_generated: z.boolean().default(true),
        overrides: z.record(TargetId, ProjectionMode).default({}),
      })
      .strict()
      .default({}),
    optimizer: z
      .object({
        proposer: z.string().default('simulated'),
        search_set: z.string().default('eval/search'),
        test_set: z.string().default('eval/test'),
        objectives: z
          .array(z.string())
          .default(['pass_rate', 'context_tokens', 'wall_clock_s', 'usd']),
        max_iterations: z.number().int().positive().default(3),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ManifestInput = z.infer<typeof ManifestSchema>;

const McpServerSchema = z
  .object({
    transport: z.enum(['stdio', 'http']).default('stdio'),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    url: z.string().url().optional(),
    headers: z.record(z.string()).default({}),
    bearer_token_env_var: z.string().optional(),
    scope: z.enum(['project', 'user', 'local']).default('project'),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio' && !v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio MCP server requires `command`' });
    }
    if (v.transport === 'http' && !v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'http MCP server requires `url`' });
    }
  });

export const McpFileSchema = z.object({
  servers: z.record(McpServerSchema).default({}),
});

const PermRuleSchema = z.object({ tool: z.string().min(1), pattern: z.string().optional() }).strict();

export const PermissionsSchema = z
  .object({
    default_mode: z.enum(['allow', 'ask', 'deny']).default('ask'),
    allow: z.array(PermRuleSchema).default([]),
    deny: z.array(PermRuleSchema).default([]),
    ask: z.array(PermRuleSchema).default([]),
    sandbox: z
      .object({
        mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
        network: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

const EnforceRuleSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().default(''),
    event: z
      .enum(['pre-tool', 'post-tool', 'user-prompt', 'stop', 'session-start'])
      .default('pre-tool'),
    match: z.string().default('*'),
    action: z.enum(['deny', 'warn', 'run']).default('warn'),
    run: z.string().optional(),
    when_files: z.array(z.string()).default([]),
    message: z.string().default(''),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === 'run' && !v.run) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `enforce rule '${v.id}' has action=run but no \`run\` command`,
      });
    }
  });

export const EnforceFileSchema = z.object({
  rule: z.array(EnforceRuleSchema).default([]),
});

export const SkillFrontmatter = z
  .object({
    name: z.string().optional(),
    description: z.string().default(''),
    'argument-hint': z.string().optional(),
    'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
    model: z.string().optional(),
  })
  .passthrough();

export const AgentFrontmatter = z
  .object({
    name: z.string().optional(),
    description: z.string().default(''),
    tools: z.union([z.string(), z.array(z.string())]).optional(),
    model: z.string().optional(),
  })
  .passthrough();

export const CommandFrontmatter = z
  .object({
    name: z.string().optional(),
    description: z.string().default(''),
    'argument-hint': z.string().optional(),
  })
  .passthrough();

export const OutputStyleFrontmatter = z
  .object({
    name: z.string().optional(),
    description: z.string().default(''),
  })
  .passthrough();
