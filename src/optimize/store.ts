/**
 * The experience store — `.harness/history/<id>/`.
 *
 * Per the paper, THIS is the asset, not the search algorithm: every evaluated
 * variant keeps its full harness snapshot, scores, RAW execution traces, and a
 * written diagnosis. The proposer reads it (grep/cat) to diagnose failures and
 * propose the next edit. Traces are stored raw and never pre-summarized — the
 * ablation showed summaries measurably hurt (34.9 vs 50.0).
 */
import path from 'node:path';
import { fs, ensureDir, copyDir, listSubdirs, pathExists, readText, writeText } from '../util/fs.js';
import { hashDir } from '../util/hash.js';

export interface VariantScores {
  variantId: string;
  parent?: string;
  pass_rate: number;
  passed: number;
  total: number;
  context_tokens: number;
  wall_clock_s: number;
  usd: number;
  valid: boolean;
  error?: string;
  /** Content hash of the harness snapshot, for dedupe across iterations. */
  hash?: string;
}

export interface Variant {
  id: string;
  dir: string;
  harnessDir: string;
  scores?: VariantScores;
  diagnosis?: string;
}

const IGNORE_IN_SNAPSHOT = ['history', '.generated'];

export function historyDir(harnessDir: string): string {
  return path.join(harnessDir, 'history');
}

/** Deterministic id: iteration index + content hash (no clocks/randomness). */
export async function variantId(index: number, harnessDir: string): Promise<string> {
  const h = await hashDir(harnessDir, IGNORE_IN_SNAPSHOT);
  return `v${String(index).padStart(2, '0')}-${h.slice(0, 8)}`;
}

/** Copy a `.harness/` tree into a variant dir, excluding history/.generated. */
export async function snapshotHarness(srcHarnessDir: string, destHarnessDir: string): Promise<void> {
  await ensureDir(destHarnessDir);
  const entries = await fs.readdir(srcHarnessDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_IN_SNAPSHOT.includes(entry.name)) continue;
    const s = path.join(srcHarnessDir, entry.name);
    const d = path.join(destHarnessDir, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) {
      await ensureDir(path.dirname(d));
      await fs.copyFile(s, d);
    }
  }
}

export async function createVariantDir(harnessDir: string, id: string): Promise<Variant> {
  const dir = path.join(historyDir(harnessDir), id);
  const variantHarness = path.join(dir, 'harness');
  await ensureDir(path.join(dir, 'traces'));
  return { id, dir, harnessDir: variantHarness };
}

export async function writeScores(variant: Variant, scores: VariantScores): Promise<void> {
  await writeText(path.join(variant.dir, 'scores.json'), JSON.stringify(scores, null, 2) + '\n');
}

export async function writeDiagnosis(variant: Variant, text: string): Promise<void> {
  await writeText(path.join(variant.dir, 'diagnosis.md'), text.endsWith('\n') ? text : text + '\n');
}

export async function writeTrace(variant: Variant, taskName: string, content: string): Promise<void> {
  const safe = taskName.replace(/[^a-zA-Z0-9._-]/g, '_');
  await writeText(path.join(variant.dir, 'traces', `${safe}.log`), content);
}

export async function listVariants(harnessDir: string): Promise<Variant[]> {
  const root = historyDir(harnessDir);
  const out: Variant[] = [];
  for (const id of (await listSubdirs(root)).sort()) {
    const dir = path.join(root, id);
    const scoresPath = path.join(dir, 'scores.json');
    let scores: VariantScores | undefined;
    if (await pathExists(scoresPath)) {
      try {
        scores = JSON.parse(await readText(scoresPath)) as VariantScores;
      } catch {
        scores = undefined;
      }
    }
    const diagPath = path.join(dir, 'diagnosis.md');
    const diagnosis = (await pathExists(diagPath)) ? await readText(diagPath) : undefined;
    out.push({ id, dir, harnessDir: path.join(dir, 'harness'), scores, diagnosis });
  }
  return out;
}
