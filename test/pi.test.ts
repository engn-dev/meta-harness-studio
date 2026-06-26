import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHarness } from '../src/config/load.js';
import { projectAll } from '../src/engine/project.js';

let dir = '';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-pi-'));
  await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
  await fs.writeFile(path.join(dir, '.harness', 'harness.toml'), 'name = "p"\ntargets = ["pi"]\n');
  await fs.writeFile(path.join(dir, '.harness', 'AGENTS.md'), '# p\n');
  await fs.writeFile(
    path.join(dir, '.harness', 'mcp.toml'),
    [
      '[servers.proj-srv]',
      'transport = "stdio"',
      'command = "npx"',
      'scope = "project"',
      '',
      '[servers.user-srv]',
      'transport = "stdio"',
      'command = "secret-cli"',
      'scope = "user"',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Pi adapter scope filtering (regression)', () => {
  it('never leaks user/local-scoped MCP servers into the committed Pi extension', async () => {
    const { spec } = await loadHarness(dir);
    const plan = projectAll(spec!);
    const ext = plan.outputs.find((o) => o.path === '.pi/extensions/mcp-servers.ts');
    expect(ext?.contents).toBeDefined();
    expect(ext!.contents).toContain('proj-srv');
    expect(ext!.contents).not.toContain('user-srv');
    expect(ext!.contents).not.toContain('secret-cli');

    const piWarning = plan.warnings.find((w) => w.target === 'pi' && /user-srv/.test(w.message));
    expect(piWarning).toBeDefined();
  });
});

describe('Pi permissions degrade to a warning, not an inert project file (regression)', () => {
  // Pi reads `defaultProjectTrust` ONLY from the global ~/.pi/agent/settings.json;
  // a project-scoped .pi/settings.json is silently ignored. So a non-default
  // permission mode must NOT emit that file — it would be a no-op — and must warn.
  it('emits no project-scoped .pi/settings.json and warns when default_mode != "ask"', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-pi-perm-'));
    await fs.mkdir(path.join(d, '.harness'), { recursive: true });
    await fs.writeFile(path.join(d, '.harness', 'harness.toml'), 'name = "p"\ntargets = ["pi"]\n');
    await fs.writeFile(path.join(d, '.harness', 'AGENTS.md'), '# p\n');
    await fs.writeFile(path.join(d, '.harness', 'permissions.toml'), 'default_mode = "deny"\n');

    const { spec } = await loadHarness(d);
    const plan = projectAll(spec!);

    expect(plan.outputs.find((o) => o.path === '.pi/settings.json')).toBeUndefined();
    const warn = plan.warnings.find(
      (w) => w.target === 'pi' && /defaultProjectTrust/.test(w.message),
    );
    expect(warn).toBeDefined();

    await fs.rm(d, { recursive: true, force: true });
  });
});
