import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditLeakage } from '../src/optimize/audit.js';

let dir = '';

async function agents(body: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'AGENTS.md'), body);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-audit-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('leakage audit', () => {
  it('flags a slug-like search-task id appearing verbatim in instructions', async () => {
    await agents('# proj\nMake sure keeps-build-command stays satisfied.\n');
    const findings = await auditLeakage(dir, ['keeps-build-command']);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('task-id-leak');
  });

  it('does NOT flag a common single-word task name (false-positive guard)', async () => {
    // A task literally named `test` must not match the ordinary word "test" in prose —
    // that false positive would silently kill legitimate optimizer improvements.
    await agents('# proj\nAlways run the test suite and the build before committing.\n');
    expect(await auditLeakage(dir, ['test', 'build'])).toEqual([]);
  });

  it('returns no findings for a clean harness', async () => {
    await agents('# proj\nKeep instructions minimal.\n');
    expect(await auditLeakage(dir, ['keeps-build-command', 'keeps-secrets-rule'])).toEqual([]);
  });
});
