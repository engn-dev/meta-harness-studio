import type { HarnessSpec } from '../config/canonical.js';
import { loadHarness, type HarnessError } from '../config/load.js';
import { log, pc } from '../util/log.js';

export function printErrors(errors: HarnessError[]): void {
  for (const e of errors) {
    log.error(`${pc.dim(e.file)} ${e.message}`);
  }
}

/**
 * Load the harness or exit. `strict` (apply/optimize) treats any validation
 * error as fatal; non-strict (verify) returns the spec so callers can report.
 */
export async function requireSpec(
  root: string,
  opts: { strict: boolean },
): Promise<{ spec: HarnessSpec; errors: HarnessError[] }> {
  const { spec, errors } = await loadHarness(root);
  if (!spec) {
    printErrors(errors);
    process.exit(1);
  }
  if (opts.strict && errors.length) {
    log.error('Harness has validation errors:');
    printErrors(errors);
    process.exit(1);
  }
  return { spec, errors };
}
