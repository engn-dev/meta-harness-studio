import { describe, it, expect } from 'vitest';
import { allAdapters } from '../src/targets/registry.js';
import { CAPABILITIES } from '../src/targets/types.js';
import { runListTargets, runDoctor } from '../src/commands/doctor.js';
import { setQuiet } from '../src/util/log.js';

const SUPPORTS = ['native', 'shim', 'codegen', 'none'];

describe('capability matrix integrity', () => {
  it('every adapter declares a valid Support value for every capability (no silent blanks)', () => {
    for (const adapter of allAdapters()) {
      for (const cap of CAPABILITIES) {
        expect(SUPPORTS, `${adapter.id}.${cap}`).toContain(adapter.capabilities[cap]);
      }
    }
  });

  it('does not advertise the vapor `modes` capability', () => {
    expect(CAPABILITIES as readonly string[]).not.toContain('modes');
    for (const adapter of allAdapters()) {
      expect((adapter.capabilities as Record<string, string>).modes).toBeUndefined();
    }
  });

  it('list-targets and doctor exit 0', async () => {
    setQuiet(true);
    expect(runListTargets()).toBe(0);
    expect(await runDoctor()).toBe(0);
  });
});
