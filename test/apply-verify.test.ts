import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runApply } from '../src/commands/apply.js';
import { runVerify } from '../src/commands/verify.js';
import { loadHarness } from '../src/config/load.js';
import { projectAll } from '../src/engine/project.js';
import { diffOutputs } from '../src/engine/write.js';
import { setQuiet } from '../src/util/log.js';

let dir = '';

async function fullProject(): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'av', scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' } }),
  );
  await runInit(dir, { yes: true });
}

function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(dir, rel)).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  setQuiet(true);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-av-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('apply ↔ verify round-trip', () => {
  it('apply writes the projected files and a second apply reports zero drift', async () => {
    await fullProject();
    expect(await runApply(dir)).toBe(0);
    expect(await exists('AGENTS.md')).toBe(true);
    expect(await exists('CLAUDE.md')).toBe(true);
    expect(await exists('.mcp.json')).toBe(false); // starter mcp.toml has no active servers

    const { spec } = await loadHarness(dir);
    const plan = projectAll(spec!);
    const drift = await diffOutputs(plan.outputs, spec!.root);
    expect(drift.every((d) => d.status === 'match')).toBe(true);
  });

  it('verify returns 0 on a freshly applied, clean harness', async () => {
    await fullProject();
    await runApply(dir);
    expect(await runVerify(dir)).toBe(0);
  });

  it('verify returns 1 when a generated file drifts from canonical', async () => {
    await fullProject();
    await runApply(dir);
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# tampered\n');
    expect(await runVerify(dir)).toBe(1);
  });

  it('verify returns 1 on a stale npm-script reference (the CI-gate guarantee)', async () => {
    await fullProject();
    await runApply(dir); // generated files in sync, so drift is not the cause
    expect(await runVerify(dir)).toBe(0);
    // Introduce a reference to a script that package.json does not define, then
    // re-apply so the only remaining problem is staleness (not drift).
    const agents = path.join(dir, '.harness', 'AGENTS.md');
    await fs.appendFile(agents, '\n- Deploy: `npm run deploy`\n');
    await runApply(dir);
    expect(await runVerify(dir)).toBe(1);
  });

  it('--dry-run writes nothing to disk', async () => {
    await fullProject();
    expect(await runApply(dir, { dryRun: true })).toBe(0);
    expect(await exists('AGENTS.md')).toBe(false);
    expect(await exists('.claude/settings.json')).toBe(false);
  });
});

describe('orphan reconciliation (a dropped target must not keep stale config)', () => {
  it('verify flags orphans (exit 1) and apply prunes them (exit 0)', async () => {
    await fullProject();
    await runApply(dir);
    expect(await exists('opencode.json')).toBe(true);

    // Drop four targets but do not re-apply yet.
    const manifest = path.join(dir, '.harness', 'harness.toml');
    const toml = await fs.readFile(manifest, 'utf8');
    await fs.writeFile(manifest, toml.replace(/targets = \[[^\]]*\]/, 'targets = ["claude-code", "codex"]'));

    // verify must catch the now-orphaned files.
    expect(await runVerify(dir)).toBe(1);
    expect(await exists('opencode.json')).toBe(true); // still there, verify doesn't delete

    // apply prunes them and the tree becomes clean again.
    expect(await runApply(dir)).toBe(0);
    expect(await exists('opencode.json')).toBe(false);
    expect(await exists('.opencode')).toBe(false); // empty parent dir pruned too
    expect(await exists('.pi')).toBe(false);
    expect(await runVerify(dir)).toBe(0);
  });
});

describe('managed .gitignore', () => {
  it('init ignores history/ by default; commit_generated=false also ignores generated config', async () => {
    await fullProject();
    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('.harness/history/');
    expect(gi).not.toMatch(/^\/AGENTS\.md/m); // commit_generated defaults true → config committed

    // Flip commit_generated and re-apply: generated paths get ignored.
    const manifest = path.join(dir, '.harness', 'harness.toml');
    const toml = await fs.readFile(manifest, 'utf8');
    await fs.writeFile(manifest, toml.replace('commit_generated = true', 'commit_generated = false'));
    await runApply(dir);
    const gi2 = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi2).toContain('/AGENTS.md');
  });
});
