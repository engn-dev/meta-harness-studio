import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHarness } from '../src/config/load.js';
import { detectStaleScripts } from '../src/engine/staleness.js';

let dir = '';

async function write(rel: string, contents: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-stale2-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('staleness across all source kinds', () => {
  it('detects undefined scripts referenced in commands and enforce-run, not just instructions', async () => {
    await write('package.json', JSON.stringify({ name: 's', scripts: { build: 'tsc', test: 'vitest' } }));
    await write('.harness/harness.toml', 'name = "s"\ntargets = ["claude-code"]\n');
    await write('.harness/AGENTS.md', '# s\nBuild with `npm run build`.\n');
    await write('.harness/commands/deploy.md', '---\ndescription: deploy\n---\nRun `npm run undefined-cmd`.\n');
    await write(
      '.harness/enforce.toml',
      '[[rule]]\nid = "lint-edit"\nevent = "post-tool"\naction = "run"\nrun = "npm run also-missing"\n',
    );

    const { spec } = await loadHarness(dir);
    const stale = await detectStaleScripts(spec!);
    const bySource = Object.fromEntries(stale.map((s) => [s.source, s.reference]));
    expect(bySource['commands/deploy.md']).toBe('undefined-cmd');
    expect(bySource['enforce/lint-edit']).toBe('also-missing');
  });

  it('does NOT false-flag a nested-package script defined in that package’s own package.json', async () => {
    // Monorepo nearest-wins: packages/api/AGENTS.md references `npm run dev`,
    // defined in packages/api/package.json (not the root).
    await write('package.json', JSON.stringify({ name: 'root', scripts: { build: 'tsc' } }));
    await write('packages/api/package.json', JSON.stringify({ name: 'api', scripts: { dev: 'tsx watch' } }));
    await write('.harness/harness.toml', 'name = "root"\ntargets = ["claude-code"]\n');
    await write('.harness/AGENTS.md', '# root\nBuild with `npm run build`.\n');
    await write('.harness/instructions/packages/api/AGENTS.md', '# api\nDev: `npm run dev`. Bad: `npm run nope`.\n');

    const { spec } = await loadHarness(dir);
    const stale = await detectStaleScripts(spec!);
    const refs = stale.map((s) => s.reference);
    expect(refs).not.toContain('dev'); // defined in the package's own package.json
    expect(refs).toContain('nope'); // genuinely undefined at every level
  });
});
