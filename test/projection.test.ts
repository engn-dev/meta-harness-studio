import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { loadHarness } from '../src/config/load.js';
import { projectAll } from '../src/engine/project.js';
import { setQuiet } from '../src/util/log.js';

let dir = '';

beforeAll(async () => {
  setQuiet(true);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-proj-'));
  await runInit(dir, { yes: true });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('projection engine', () => {
  it('dedupes the shared AGENTS.md into one file owned by all 6 targets', async () => {
    const { spec } = await loadHarness(dir);
    expect(spec).toBeDefined();
    const plan = projectAll(spec!);
    const agents = plan.outputs.find((o) => o.path === 'AGENTS.md');
    expect(agents).toBeDefined();
    expect(agents!.targets.sort()).toEqual(['claude-code', 'cline', 'codex', 'kilo', 'opencode', 'pi']);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('emits a CLAUDE.md import shim (Claude Code has no AGENTS.md fallback)', async () => {
    const { spec } = await loadHarness(dir);
    const plan = projectAll(spec!);
    const claudeMd = plan.outputs.find((o) => o.path === 'CLAUDE.md');
    expect(claudeMd?.contents).toContain('@AGENTS.md');
    expect(claudeMd?.targets).toEqual(['claude-code']);
  });

  it('writes skills to both .claude/skills and the shared .agents/skills (Pi)', async () => {
    const { spec } = await loadHarness(dir);
    const plan = projectAll(spec!);
    const paths = plan.outputs.map((o) => o.path);
    expect(paths).toContain('.claude/skills/example-skill/SKILL.md');
    expect(paths).toContain('.agents/skills/example-skill/SKILL.md');
  });

  it('dedupes Claude deny rules that arrive from both permissions and enforce', async () => {
    const { spec } = await loadHarness(dir);
    const plan = projectAll(spec!);
    const settings = plan.outputs.find((o) => o.path === '.claude/settings.json');
    expect(settings?.contents).toBeDefined();
    const parsed = JSON.parse(settings!.contents!) as { permissions: { deny: string[] } };
    // The starter has a permissions Read deny AND a block-env-read enforce rule —
    // both produce Read(./.env*); the output must not duplicate it.
    expect(parsed.permissions.deny).toEqual([...new Set(parsed.permissions.deny)]);
    expect(parsed.permissions.deny.filter((d) => d === 'Read(./.env*)')).toHaveLength(1);
  });

  it('projects per-tool config to the right native locations', async () => {
    const { spec } = await loadHarness(dir);
    const plan = projectAll(spec!);
    const paths = new Set(plan.outputs.map((o) => o.path));
    expect(paths).toContain('opencode.json'); // OpenCode permissions/MCP
    expect(paths).toContain('.codex/config.toml'); // Codex approval/sandbox
    expect(paths).toContain('.clinerules/workflows/review.md'); // Cline workflow
    expect(paths).toContain('.pi/prompts/review.md'); // Pi prompt template
  });
});
