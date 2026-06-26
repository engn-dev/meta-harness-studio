import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthor } from '../src/commands/author.js';
import { enrichWithLlm } from '../src/author/llm.js';

let dir = '';
let harnessDir = '';
let agentsPath = '';
let draft = '';

/** Scaffold a repo and run the deterministic author so a valid .harness/ exists. */
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-llm-'));
  const pkg = {
    name: 'svc',
    scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
  };
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(dir, 'src', 'index.ts'), "console.log('x')\n");
  await runAuthor(dir); // deterministic baseline
  harnessDir = path.join(dir, '.harness');
  agentsPath = path.join(harnessDir, 'AGENTS.md');
  draft = await fs.readFile(agentsPath, 'utf8');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('LLM authoring pass (Phase 1) — validate-or-revert', () => {
  it('applies a valid enrichment', async () => {
    // A "proposer" that adds a genuine, non-stale fact.
    const proposer = `printf '\\n## Architecture\\n- The entrypoint is src/index.ts.\\n' >> .harness/AGENTS.md`;
    const res = await enrichWithLlm(proposer, dir, harnessDir);

    expect(res.applied).toBe(true);
    expect(res.reverted).toBe(false);
    const after = await fs.readFile(agentsPath, 'utf8');
    expect(after).toContain('The entrypoint is src/index.ts.');
  });

  it('REVERTS a run that introduces a hallucinated command', async () => {
    // `npm run deploy` references a script that does not exist → detectStaleScripts fires.
    const proposer = `printf '\\n- Deploy: npm run deploy\\n' >> .harness/AGENTS.md`;
    const res = await enrichWithLlm(proposer, dir, harnessDir);

    expect(res.reverted).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.note).toMatch(/hallucinated command/);
    // AGENTS.md is byte-for-byte the deterministic draft again.
    expect(await fs.readFile(agentsPath, 'utf8')).toBe(draft);
  });

  it('REVERTS a run that injects a literal secret into mcp.toml', async () => {
    // The agent is told to touch only AGENTS.md; this one violates that AND pastes a
    // literal secret. The whole-harness snapshot must roll mcp.toml back too.
    const proposer = `printf '\\n[servers.x]\\ncommand = "y"\\nenv = { API_KEY = "sk-literal-123" }\\n' >> .harness/mcp.toml`;
    const res = await enrichWithLlm(proposer, dir, harnessDir);

    expect(res.reverted).toBe(true);
    expect(res.note).toMatch(/literal secret/);
    expect(await fs.readFile(path.join(harnessDir, 'mcp.toml'), 'utf8')).not.toContain('sk-literal-123');
  });

  it('reports no-op when the agent changes nothing', async () => {
    const res = await enrichWithLlm('true', dir, harnessDir); // `true` exits 0, edits nothing
    expect(res.applied).toBe(false);
    expect(res.reverted).toBe(false);
    expect(res.note).toMatch(/no change/);
    expect(await fs.readFile(agentsPath, 'utf8')).toBe(draft);
  });

  it('runAuthor --proposer enriches end-to-end and stays valid', async () => {
    // Fresh repo so we exercise the full runAuthor path with the proposer.
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-llm-e2e-'));
    await fs.writeFile(path.join(fresh, 'package.json'), '{"name":"e2e","scripts":{"build":"tsc"}}');
    const proposer = `printf '\\n## Gotchas\\n- Build artifacts are not committed.\\n' >> .harness/AGENTS.md`;

    const code = await runAuthor(fresh, { proposer });
    expect(code).toBe(0);
    const agents = await fs.readFile(path.join(fresh, '.harness', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Build artifacts are not committed.');
    await fs.rm(fresh, { recursive: true, force: true });
  });
});
