/**
 * `harness list-targets` — the capability matrix (what each tool can express).
 * `harness doctor` — environment checks (Node + which agent CLIs are installed).
 */
import { spawn } from 'node:child_process';
import { REGISTRY, allAdapters } from '../targets/registry.js';
import { CAPABILITIES, type Support } from '../targets/types.js';
import type { TargetId } from '../config/canonical.js';
import { log, pc } from '../util/log.js';

const SYMBOL: Record<Support, string> = {
  native: pc.green('●'),
  shim: pc.yellow('◐'),
  codegen: pc.cyan('⚙'),
  none: pc.dim('·'),
};

export function runListTargets(): number {
  const adapters = allAdapters();
  const colW = 12;
  const capW = 13;

  log.heading('Target capability matrix');
  const header = 'capability'.padEnd(capW) + adapters.map((a) => a.id.padEnd(colW)).join('');
  log.info('  ' + pc.bold(header));
  for (const cap of CAPABILITIES) {
    // Symbols carry ANSI codes, so pad by visible width (1) manually.
    const row =
      cap.padEnd(capW) +
      adapters.map((a) => SYMBOL[a.capabilities[cap]] + ' '.repeat(colW - 1)).join('');
    log.info('  ' + row);
  }
  log.info('');
  log.dim(`  ${SYMBOL.native} native   ${SYMBOL.shim} shim/bridge   ${SYMBOL.codegen} code-gen   ${SYMBOL.none} unsupported`);
  return 0;
}

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${bin}`]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

const CLI_FOR: Partial<Record<TargetId, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

export async function runDoctor(): Promise<number> {
  log.heading('Environment');
  log.info(`  node ${process.version}`);

  log.heading('Installed agent CLIs');
  for (const id of Object.keys(REGISTRY) as TargetId[]) {
    const bin = CLI_FOR[id];
    if (!bin) {
      log.dim(`  ${id.padEnd(14)} (VS Code extension — not a CLI)`);
      continue;
    }
    const found = await which(bin);
    if (found) log.info(`  ${id.padEnd(14)} ${pc.green('found')} ${pc.dim(found)}`);
    else log.info(`  ${id.padEnd(14)} ${pc.dim(`not found (${bin})`)}`);
  }
  log.dim('\n  Missing a CLI is fine — `harness apply` still generates its config files.');
  return 0;
}
