import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHarness } from '../src/config/load.js';
import { detectStaleScripts } from '../src/engine/staleness.js';

let dir = '';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-stale-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 's', scripts: { build: 'tsc', test: 'vitest' } }),
  );
  await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
  await fs.writeFile(path.join(dir, '.harness', 'harness.toml'), 'name = "s"\ntargets = ["pi"]\n');
  await fs.writeFile(
    path.join(dir, '.harness', 'AGENTS.md'),
    [
      '# s',
      '- Build: `npm run build`', // defined → not stale
      '- Deps: `pnpm install`', // builtin, no `run` → must NOT be flagged
      '- Add: `yarn add react`', // builtin, no `run` → must NOT be flagged
      '- Deploy: `npm run deploy`', // explicit run, undefined → STALE
      '- Lint: `pnpm run lint`', // explicit run, undefined → STALE
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('staleness detection', () => {
  it('flags only undefined scripts behind an explicit `run`, never PM builtins', async () => {
    const { spec } = await loadHarness(dir);
    const stale = await detectStaleScripts(spec!);
    const refs = stale.map((s) => s.reference).sort();
    expect(refs).toEqual(['deploy', 'lint']);
    // The regression: `pnpm install` / `yarn add` must not be mistaken for scripts.
    expect(refs).not.toContain('install');
    expect(refs).not.toContain('add');
    expect(refs).not.toContain('build');
  });
});
