import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHarness } from '../src/config/load.js';

let dir = '';

async function writeHarness(files: Record<string, string>): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, '.harness', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
}

const MANIFEST = 'name = "t"\ntargets = ["claude-code"]\n';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-val-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('interface-validation gate', () => {
  it('rejects a stdio MCP server with no command', async () => {
    await writeHarness({
      'harness.toml': MANIFEST,
      'mcp.toml': '[servers.broken]\ntransport = "stdio"\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.some((e) => /stdio MCP server requires .command./.test(e.message))).toBe(true);
  });

  it('rejects an enforce rule with action=run and no run command', async () => {
    await writeHarness({
      'harness.toml': MANIFEST,
      'enforce.toml': '[[rule]]\nid = "x"\naction = "run"\nevent = "post-tool"\n',
    });
    const { errors } = await loadHarness(dir);
    expect(errors.some((e) => /action=run but no .run. command/.test(e.message))).toBe(true);
  });

  it('reports a missing manifest as a clear, actionable error', async () => {
    const { spec, errors } = await loadHarness(dir);
    expect(spec).toBeUndefined();
    expect(errors[0]?.message).toMatch(/harness init/);
  });

  it('accepts a minimal valid harness with no errors', async () => {
    await writeHarness({ 'harness.toml': MANIFEST, 'AGENTS.md': '# t\n' });
    const { spec, errors } = await loadHarness(dir);
    expect(errors).toHaveLength(0);
    expect(spec?.manifest.name).toBe('t');
  });

  it('flags an unknown top-level manifest key (strict)', async () => {
    await writeHarness({ 'harness.toml': 'name = "t"\ntargets = ["pi"]\ntargdets = ["typo"]\n' });
    const { errors } = await loadHarness(dir);
    expect(errors.length).toBeGreaterThan(0);
  });
});
