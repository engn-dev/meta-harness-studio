import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthor } from '../src/commands/author.js';
import { scanRepo } from '../src/author/scan.js';
import { rankImportantFiles } from '../src/author/importance.js';
import { enrichWithLlm } from '../src/author/llm.js';

let dir = '';

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-roadmap-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Phase 3 — file-importance ranking', () => {
  it('surfaces the most-imported module', async () => {
    await write('src/core.ts', 'export const x = 1;\n');
    await write('src/a.ts', "import { x } from './core.js';\n");
    await write('src/b.ts', "import { x } from './core.js';\n");
    await write('src/c.ts', "import { x } from './core.js';\n");

    const ranked = await rankImportantFiles(dir);
    expect(ranked[0]).toBe('src/core.ts'); // imported 3×, the most central
  });

  it('feeds central modules into the digest keyPaths', async () => {
    await write('package.json', '{"name":"svc","scripts":{"build":"tsc"}}');
    await write('src/core.ts', 'export const x = 1;\n');
    await write('src/a.ts', "import { x } from './core.js';\n");
    await write('src/b.ts', "import { x } from './core.js';\n");

    const digest = await scanRepo(dir);
    expect(digest.keyPaths).toContain('src/core.ts');
  });

  it('is a silent no-op on a non-JS repo', async () => {
    await write('main.go', 'package main\n');
    expect(await rankImportantFiles(dir)).toEqual([]);
  });

  it('resolves bundler query-suffixed import specifiers', async () => {
    await write('src/worker.ts', 'export default 1;\n');
    await write('src/a.ts', "import W from './worker?worker';\n");
    await write('src/b.ts', "import W from './worker.js?worker';\n");
    expect(await rankImportantFiles(dir)).toContain('src/worker.ts');
  });
});

describe('decision #3 — LLM-drafted skills/agents', () => {
  async function scaffold(): Promise<void> {
    await write('package.json', '{"name":"svc","scripts":{"build":"tsc","test":"vitest run"}}');
    await write('src/index.ts', "console.log('x')\n");
    await runAuthor(dir); // deterministic baseline (creates the `testing` skill)
  }

  it('keeps and reports a valid drafted skill', async () => {
    await scaffold();
    const harnessDir = path.join(dir, '.harness');
    const proposer =
      `mkdir -p .harness/skills/migrate && ` +
      `printf -- '---\\nname: migrate\\ndescription: Run DB migrations.\\n---\\n\\n# Migrate\\n' ` +
      `> .harness/skills/migrate/SKILL.md`;

    const res = await enrichWithLlm(proposer, dir, harnessDir);
    expect(res.reverted).toBe(false);
    expect(
      await fs.access(path.join(harnessDir, 'skills', 'migrate', 'SKILL.md')).then(() => true, () => false),
    ).toBe(true);
  });

  it('REVERTS a drafted skill that collides with an existing name', async () => {
    await scaffold(); // deterministic `testing` skill already exists
    const harnessDir = path.join(dir, '.harness');
    // A second skill dir whose frontmatter name duplicates `testing` → loader error.
    const proposer =
      `mkdir -p .harness/skills/dup && ` +
      `printf -- '---\\nname: testing\\ndescription: dup.\\n---\\n\\n# Dup\\n' > .harness/skills/dup/SKILL.md`;

    const res = await enrichWithLlm(proposer, dir, harnessDir);
    expect(res.reverted).toBe(true);
    expect(
      await fs.access(path.join(harnessDir, 'skills', 'dup')).then(() => true, () => false),
    ).toBe(false); // rolled back
  });

  it('REVERTS a drafted skill that references a non-existent script', async () => {
    await scaffold();
    const harnessDir = path.join(dir, '.harness');
    // A skill body naming a script the repo does not define → staleness must catch it
    // (skills/agents are now scanned, not just AGENTS.md).
    const proposer =
      `mkdir -p .harness/skills/migrate && ` +
      `printf -- '---\\nname: migrate\\ndescription: Migrations.\\n---\\n\\nRun npm run migrate:up.\\n' ` +
      `> .harness/skills/migrate/SKILL.md`;

    const res = await enrichWithLlm(proposer, dir, harnessDir);
    expect(res.reverted).toBe(true);
    expect(res.note).toMatch(/hallucinated command/);
    expect(
      await fs.access(path.join(harnessDir, 'skills', 'migrate')).then(() => true, () => false),
    ).toBe(false);
  });
});

describe('Phase 2 — --optimize chain', () => {
  it('authors then runs optimize, returning success', async () => {
    await write('package.json', '{"name":"svc","scripts":{"build":"tsc","test":"vitest run"}}');
    await write('src/index.ts', "console.log('x')\n");

    const code = await runAuthor(dir, { optimize: true });
    expect(code).toBe(0);
    // optimize ran against the freshly-authored harness → a history store exists.
    expect(
      await fs.access(path.join(dir, '.harness', 'history')).then(() => true, () => false),
    ).toBe(true);
  });
});
