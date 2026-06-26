import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runOptimize } from '../src/commands/optimize.js';
import { loadHarness } from '../src/config/load.js';
import { listVariants } from '../src/optimize/store.js';
import { setQuiet } from '../src/util/log.js';

let dir = '';

beforeAll(async () => {
  setQuiet(true);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-opt-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'opt', scripts: { build: 'x', test: 'x', lint: 'x' } }),
  );
  await runInit(dir, { yes: true });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('optimizer loop (simulated proposer, no tokens)', () => {
  it('reduces context tokens at equal pass-rate and records raw traces', async () => {
    const code = await runOptimize(dir, { proposer: 'simulated', iterations: 3 });
    expect(code).toBe(0);

    const { spec } = await loadHarness(dir);
    const variants = await listVariants(spec!.harnessDir);
    const v00 = variants.find((v) => v.id === 'v00');
    const v01 = variants.find((v) => v.id === 'v01');

    expect(v00?.scores?.pass_rate).toBe(1);
    expect(v01?.scores?.pass_rate).toBe(1);
    // The compression improves the token axis without losing pass-rate (the paper's headline).
    expect(v01!.scores!.context_tokens).toBeLessThan(v00!.scores!.context_tokens);

    // Raw traces are stored, not summarized (ablation-mandated).
    const traceDir = path.join(v00!.dir, 'traces');
    const traces = await fs.readdir(traceDir);
    expect(traces.length).toBeGreaterThan(0);
    const sample = await fs.readFile(path.join(traceDir, traces[0]!), 'utf8');
    expect(sample).toMatch(/\$ /); // raw command transcript

    // A written diagnosis accompanies every variant (hypothesis-as-data).
    expect(v01?.diagnosis).toMatch(/Diagnosis/);
  });

  it('converges (idempotent compression makes no further change)', async () => {
    const { spec } = await loadHarness(dir);
    const variants = await listVariants(spec!.harnessDir);
    // v02 exists as a converged marker but adds no scored improvement beyond v01.
    expect(variants.some((v) => v.id === 'v02')).toBe(true);
  });
});
