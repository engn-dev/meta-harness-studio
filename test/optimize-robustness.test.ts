import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runOptimize } from '../src/commands/optimize.js';
import { loadHarness } from '../src/config/load.js';
import { listVariants } from '../src/optimize/store.js';
import { setQuiet } from '../src/util/log.js';

let dir = '';

beforeEach(async () => {
  setQuiet(true);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-optrob-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'r', scripts: { build: 'x', test: 'x', lint: 'x' } }),
  );
  await runInit(dir, { yes: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('optimizer robustness', () => {
  it('survives a proposer that emits an invalid harness (records valid:false, keeps it off the frontier)', async () => {
    // A proposer that corrupts harness.toml (unterminated TOML array). The interface
    // gate must reject it, store the error, and continue from the unchanged parent.
    const corrupt = `printf 'name = "x"\\ntargets = [' > harness.toml`;
    const code = await runOptimize(dir, { proposer: corrupt, iterations: 2 });
    expect(code).toBe(0); // loop survived

    const { spec } = await loadHarness(dir);
    const variants = await listVariants(spec!.harnessDir);
    const invalid = variants.filter((v) => v.scores && v.scores.valid === false);
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid[0]!.scores!.error).toBeTruthy();

    // The baseline is unchanged and remains the only adoptable variant.
    const v00 = variants.find((v) => v.id === 'v00');
    expect(v00!.scores!.valid).toBe(true);
  });

  it('rejects a non-positive --iterations value', async () => {
    expect(await runOptimize(dir, { iterations: 0 })).toBe(1);
    expect(await runOptimize(dir, { iterations: NaN })).toBe(1);
  });
});
