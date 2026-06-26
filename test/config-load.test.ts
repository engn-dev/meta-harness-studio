import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHarness } from '../src/config/load.js';
import { detectLiteralSecrets } from '../src/config/secrets.js';
import type { McpServer } from '../src/config/canonical.js';

let dir = '';
const MANIFEST = 'name = "t"\ntargets = ["claude-code"]\n';

async function write(files: Record<string, string>): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, '.harness', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-cfg-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('nested (monorepo) instructions', () => {
  it('projects instructions/<pkg>/AGENTS.md to <pkg>/AGENTS.md', async () => {
    await write({
      'harness.toml': MANIFEST,
      'AGENTS.md': '# root\n',
      'instructions/packages/api/AGENTS.md': '# api package\n',
    });
    const { spec, errors } = await loadHarness(dir);
    expect(errors).toHaveLength(0);
    const paths = spec!.instructions.map((d) => d.path).sort();
    expect(paths).toEqual(['AGENTS.md', 'packages/api/AGENTS.md']);
  });

  it('rejects a bare instructions/AGENTS.md that would shadow the root', async () => {
    await write({
      'harness.toml': MANIFEST,
      'AGENTS.md': '# root\n',
      'instructions/AGENTS.md': '# ambiguous\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.some((e) => /package subdirectory/.test(e.message))).toBe(true);
  });
});

describe('duplicate definition names', () => {
  it('flags two skills resolving to the same name', async () => {
    await write({
      'harness.toml': MANIFEST,
      'skills/one/SKILL.md': '---\nname: dup\ndescription: a\n---\nbody\n',
      'skills/two/SKILL.md': '---\nname: dup\ndescription: b\n---\nbody\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.some((e) => /duplicate skills name 'dup'/.test(e.message))).toBe(true);
  });
});

describe('strict TOML schemas (typos surface, not silently dropped)', () => {
  it('rejects an unknown key on an MCP server', async () => {
    await write({
      'harness.toml': MANIFEST,
      'mcp.toml': '[servers.x]\ntransport = "stdio"\ncommand = "npx"\ncomand = "typo"\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects the removed optimizer.candidates_per_iteration key', async () => {
    await write({
      'harness.toml': 'name = "t"\ntargets = ["pi"]\n[optimizer]\ncandidates_per_iteration = 2\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an http MCP server with no url (symmetric to the stdio case)', async () => {
    await write({
      'harness.toml': MANIFEST,
      'mcp.toml': '[servers.x]\ntransport = "http"\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.some((e) => /http MCP server requires .url./.test(e.message))).toBe(true);
  });
});

describe('literal-secret detection', () => {
  const base: Omit<McpServer, 'env' | 'headers'> = {
    name: 'gh',
    transport: 'stdio',
    command: 'npx',
    args: [],
    scope: 'project',
    enabled: true,
  };

  it('flags a pasted credential under a secret-named key', () => {
    const s: McpServer = { ...base, env: { GITHUB_TOKEN: 'ghp_realLiteralToken123' }, headers: {} };
    const findings = detectLiteralSecrets([s]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ server: 'gh', field: 'env', key: 'GITHUB_TOKEN' });
  });

  it('accepts ${ENV} references and non-secret literals', () => {
    const s: McpServer = {
      ...base,
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', NODE_ENV: 'production' },
      headers: {},
    };
    expect(detectLiteralSecrets([s])).toEqual([]);
  });
});
