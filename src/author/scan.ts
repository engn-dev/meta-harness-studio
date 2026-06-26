/**
 * Deterministic repo scanner — the eyes of `harness author`.
 *
 * Turns an arbitrary project directory into a `RepoDigest` from cheap, local
 * signals (manifests, lockfiles, a shallow extension census, config presence).
 * No LLM, no network, no shelling out: the same inputs always yield the same
 * digest, which is what lets the renderer and eval-gen trust it. Every signal is
 * best-effort — a missing or malformed file just means fewer fields, never a
 * crash. The `<pm> run <script>` commands we emit only ever name scripts we read
 * straight out of `package.json`, so `detectStaleScripts` stays green by design.
 */
import path from 'node:path';
import { glob } from 'tinyglobby';
import { parse as parseToml } from 'smol-toml';
import type {
  DetectedCommand,
  PackageManager,
  RepoDigest,
  RepoSignals,
} from './types.js';
import { inferMcpServers } from './mcp-map.js';
import { rankImportantFiles } from './importance.js';
import { pathExists, readTextOr, listDir } from '../util/fs.js';

/** Directories never worth crawling for the census, regardless of .gitignore. */
const IGNORE_DIRS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/vendor/**',
  '**/target/**',
  '**/out/**',
  '**/.next/**',
];

/** Cap on files inspected by the extension census — bounds cost on huge repos. */
const CENSUS_LIMIT = 4000;

/** Extension → human language, for the file-extension census. */
const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
};

/** dependency-name (lowercased) → framework label worth naming. */
const FRAMEWORK_MAP: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  svelte: 'Svelte',
  '@angular/core': 'Angular',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  koa: 'Koa',
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  rails: 'Rails',
  vitest: 'Vitest',
  jest: 'Jest',
  '@playwright/test': 'Playwright',
  playwright: 'Playwright',
  pytest: 'pytest',
};

/** Best-effort JSON parse; never throws. */
function tryJson(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort TOML parse; never throws. */
function tryToml(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Dependency names from a package.json's deps + devDeps, lowercased. */
function pkgDeps(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const block = pkg[key];
    if (block && typeof block === 'object') {
      for (const name of Object.keys(block as Record<string, unknown>)) out.push(name.toLowerCase());
    }
  }
  return out;
}

/** First non-heading, non-empty prose line of a README, for a description fallback. */
function readmeDescription(readme: string): string | undefined {
  for (const raw of readme.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('![') || line.startsWith('<')) continue;
    if (line.startsWith('>') || line.startsWith('---') || line.startsWith('|')) continue;
    return line.length > 200 ? line.slice(0, 197) + '...' : line;
  }
  return undefined;
}

/** Push `lang` to the front-of-order list if not already present. */
function addLang(langs: string[], lang: string): void {
  if (!langs.includes(lang)) langs.push(lang);
}

export async function scanRepo(root: string): Promise<RepoDigest> {
  // --- Read the manifests we care about, all best-effort. ---
  const pkg = tryJson(await readTextOr(path.join(root, 'package.json')));
  const pyproject = tryToml(await readTextOr(path.join(root, 'pyproject.toml')));
  const cargo = tryToml(await readTextOr(path.join(root, 'Cargo.toml')));
  const readme = await readTextOr(path.join(root, 'README.md'));

  // --- name + description ---
  let name = asStr(pkg?.name);
  let description = asStr(pkg?.description);
  if (!name) name = asStr((pyproject?.project as Record<string, unknown> | undefined)?.name);
  if (!description)
    description = asStr((pyproject?.project as Record<string, unknown> | undefined)?.description);
  if (!name) name = asStr((cargo?.package as Record<string, unknown> | undefined)?.name);
  if (!description)
    description = asStr((cargo?.package as Record<string, unknown> | undefined)?.description);
  if (!name) name = path.basename(root);
  if (!description && readme) description = readmeDescription(readme);

  // --- package manager (JS only) ---
  let packageManager: PackageManager | undefined;
  if (await pathExists(path.join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (await pathExists(path.join(root, 'yarn.lock'))) packageManager = 'yarn';
  else if (await pathExists(path.join(root, 'bun.lockb'))) packageManager = 'bun';
  else if (pkg || (await pathExists(path.join(root, 'package-lock.json')))) packageManager = 'npm';

  // --- ecosystem presence flags ---
  const hasTsconfig = await pathExists(path.join(root, 'tsconfig.json'));
  const hasRequirements = await pathExists(path.join(root, 'requirements.txt'));
  const hasSetupPy = await pathExists(path.join(root, 'setup.py'));
  const hasPython = !!pyproject || hasRequirements || hasSetupPy;
  const hasGoMod = await pathExists(path.join(root, 'go.mod'));
  const hasGemfile = await pathExists(path.join(root, 'Gemfile'));
  const hasPom = await pathExists(path.join(root, 'pom.xml'));
  const hasGradleKts = await pathExists(path.join(root, 'build.gradle.kts'));
  const hasGradle = (await pathExists(path.join(root, 'build.gradle'))) || hasGradleKts;

  // --- collect dependency names across manifests ---
  const dependencies: string[] = [];
  if (pkg) dependencies.push(...pkgDeps(pkg));
  if (pyproject) {
    // PEP 621 `[project.dependencies]` is an array of requirement strings.
    const projDeps = (pyproject.project as Record<string, unknown> | undefined)?.dependencies;
    if (Array.isArray(projDeps)) {
      for (const d of projDeps) {
        if (typeof d === 'string') {
          const m = d.match(/^[A-Za-z0-9._-]+/);
          if (m) dependencies.push(m[0].toLowerCase());
        }
      }
    }
  }
  if (hasRequirements) {
    const reqs = await readTextOr(path.join(root, 'requirements.txt'));
    for (const raw of reqs.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const m = line.match(/^[A-Za-z0-9._-]+/);
      if (m) dependencies.push(m[0].toLowerCase());
    }
  }
  if (cargo) {
    const cargoDeps = cargo.dependencies;
    if (cargoDeps && typeof cargoDeps === 'object') {
      for (const d of Object.keys(cargoDeps as Record<string, unknown>)) dependencies.push(d.toLowerCase());
    }
  }
  const depSet = new Set(dependencies);

  // --- languages: manifests first (most authoritative), then census ---
  const languages: string[] = [];
  if (pkg || hasTsconfig) addLang(languages, hasTsconfig ? 'TypeScript' : 'JavaScript');
  if (hasPython) addLang(languages, 'Python');
  if (cargo) addLang(languages, 'Rust');
  if (hasGoMod) addLang(languages, 'Go');
  if (hasGemfile) addLang(languages, 'Ruby');
  if (hasPom || hasGradle) addLang(languages, hasGradleKts && !hasPom ? 'Kotlin' : 'Java');

  // Census: count source files by extension to order and catch unmanifested langs.
  const census = new Map<string, number>();
  try {
    const files = await glob('**/*', {
      cwd: root,
      ignore: IGNORE_DIRS,
      onlyFiles: true,
      dot: false,
    });
    for (let i = 0; i < files.length && i < CENSUS_LIMIT; i++) {
      const ext = path.extname(files[i]!).toLowerCase();
      const lang = EXT_LANG[ext];
      if (lang) census.set(lang, (census.get(lang) ?? 0) + 1);
    }
  } catch {
    // Census is a bonus signal; manifest-derived languages still stand.
  }
  // Order manifest-derived languages by census count (desc), then append any
  // census-only languages, then any remaining.
  const ranked = [...languages].sort((a, b) => (census.get(b) ?? 0) - (census.get(a) ?? 0));
  for (const [lang] of [...census.entries()].sort((a, b) => b[1] - a[1])) {
    if (!ranked.includes(lang)) ranked.push(lang);
  }
  const finalLanguages = ranked;

  // --- frameworks from dependency names ---
  const frameworks: string[] = [];
  for (const [dep, label] of Object.entries(FRAMEWORK_MAP)) {
    if (depSet.has(dep) && !frameworks.includes(label)) frameworks.push(label);
  }

  // --- commands ---
  const commands = buildCommands(pkg, packageManager, {
    cargo: !!cargo,
    go: hasGoMod,
    python: hasPython,
    pythonDeps: depSet,
    makefile: await readTextOr(path.join(root, 'Makefile')),
  });

  // --- keyPaths: declared entrypoints/configs first, then the most-imported
  // modules (centrality the manifest can't name), deduped and capped at 8. ---
  const declaredPaths = await collectKeyPaths(root, pkg);
  const central = await rankImportantFiles(root);
  const keyPaths: string[] = [];
  for (const p of [...declaredPaths, ...central]) {
    if (!keyPaths.includes(p)) keyPaths.push(p);
    if (keyPaths.length >= 8) break;
  }

  // --- workspaces ---
  const workspaces = await collectWorkspaces(root, pkg);

  // --- signals ---
  const signals: RepoSignals = {
    hasEnvFiles: await hasEnvFiles(root),
    buildOutputDir: await firstExistingDir(root, ['dist', 'build', 'out', 'target', '.next']),
    hasGithubDir: await pathExists(path.join(root, '.github')),
    hasCI: await detectCI(root),
    dependencies,
  };

  const mcpServers = inferMcpServers(signals);

  // --- imported instructions ---
  const imported = await firstNonEmpty(root, ['AGENTS.md', 'CLAUDE.md', '.cursorrules']);

  return {
    name,
    ...(description ? { description } : {}),
    root,
    ...(packageManager ? { packageManager } : {}),
    languages: finalLanguages,
    frameworks,
    commands,
    keyPaths,
    workspaces,
    mcpServers,
    signals,
    ...(imported ? { imported } : {}),
  };
}

/** Map a script name to a canonical command kind, or undefined if generic. */
function scriptKind(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n === 'build' || n.startsWith('build:')) return 'build';
  if (n === 'test' || n.startsWith('test:')) return 'test';
  if (n === 'lint' || n.startsWith('lint:')) return 'lint';
  if (n === 'typecheck' || n === 'tsc' || n === 'type-check' || n === 'types') return 'typecheck';
  if (n === 'dev' || n === 'develop') return 'dev';
  if (n === 'start' || n === 'serve') return 'start';
  return undefined;
}

const COMMAND_ORDER = ['build', 'test', 'lint', 'typecheck', 'dev', 'start'];

function sortCommands(cmds: DetectedCommand[]): DetectedCommand[] {
  const rank = (k: string): number => {
    const i = COMMAND_ORDER.indexOf(k);
    return i === -1 ? COMMAND_ORDER.length : i;
  };
  return [...cmds].sort((a, b) => rank(a.kind) - rank(b.kind));
}

function buildCommands(
  pkg: Record<string, unknown> | undefined,
  pm: PackageManager | undefined,
  eco: { cargo: boolean; go: boolean; python: boolean; pythonDeps: Set<string>; makefile: string },
): DetectedCommand[] {
  const cmds: DetectedCommand[] = [];

  // JS scripts → commands. Only emit `<pm> run <script>` for scripts that exist.
  const scripts = pkg?.scripts;
  if (pm && scripts && typeof scripts === 'object') {
    const names = Object.keys(scripts as Record<string, unknown>);
    const seenKind = new Set<string>();
    // `<pm> test` is staleness-safe (a builtin) and idiomatic; emit it if a test script exists.
    if (names.includes('test')) {
      cmds.push({ kind: 'test', cmd: `${pm} test`, script: 'test' });
      seenKind.add('test');
    }
    // The renderer emits `<pm> run <scriptName>`, and `detectStaleScripts` only
    // recognizes names matching its own [a-zA-Z0-9:_-] capture. A script named
    // `ci.test` / `lint web` / `db@migrate` would be parsed as a different, missing
    // script and fail `verify` — so we never emit a `run` form for an unsafe name.
    const STALE_SAFE = /^[a-zA-Z0-9:_-]+$/;
    for (const scriptName of names) {
      const kind = scriptKind(scriptName);
      if (kind === 'test') continue; // already handled via `<pm> test`
      if (!STALE_SAFE.test(scriptName)) continue;
      const role = kind ?? scriptName;
      // Avoid duplicate canonical roles (e.g. both `build` and `build:prod`).
      if (kind && seenKind.has(kind)) continue;
      if (kind) seenKind.add(kind);
      cmds.push({ kind: role, cmd: `${pm} run ${scriptName}`, script: scriptName });
    }
    return sortCommands(cmds);
  }

  // Non-JS ecosystems.
  if (eco.cargo) {
    cmds.push({ kind: 'build', cmd: 'cargo build' });
    cmds.push({ kind: 'test', cmd: 'cargo test' });
  }
  if (eco.go) {
    cmds.push({ kind: 'build', cmd: 'go build ./...' });
    cmds.push({ kind: 'test', cmd: 'go test ./...' });
  }
  if (eco.python) {
    if (eco.pythonDeps.has('pytest')) cmds.push({ kind: 'test', cmd: 'pytest' });
    if (eco.pythonDeps.has('ruff')) cmds.push({ kind: 'lint', cmd: 'ruff check' });
    else if (eco.pythonDeps.has('black')) cmds.push({ kind: 'lint', cmd: 'black --check .' });
  }
  // Makefile targets, if present and recognized.
  if (eco.makefile) {
    const targets = makefileTargets(eco.makefile);
    for (const t of ['build', 'test', 'lint']) {
      if (targets.has(t) && !cmds.some((c) => c.kind === t)) {
        cmds.push({ kind: t, cmd: `make ${t}` });
      }
    }
  }
  return sortCommands(cmds);
}

/** Recognized top-level Makefile target names (e.g. `build:`). */
function makefileTargets(makefile: string): Set<string> {
  const out = new Set<string>();
  for (const raw of makefile.split('\n')) {
    const m = raw.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m && m[1]) out.add(m[1]);
  }
  return out;
}

/** Collect load-bearing, on-disk, repo-relative paths an agent should know. Capped at 8. */
async function collectKeyPaths(
  root: string,
  pkg: Record<string, unknown> | undefined,
): Promise<string[]> {
  const candidates: string[] = [];

  // package.json declared entrypoints.
  if (pkg) {
    for (const field of ['main', 'module'] as const) {
      const v = asStr(pkg[field]);
      if (v) candidates.push(v);
    }
    const bin = pkg.bin;
    if (typeof bin === 'string') candidates.push(bin);
    else if (bin && typeof bin === 'object') {
      for (const v of Object.values(bin as Record<string, unknown>)) {
        if (typeof v === 'string') candidates.push(v);
      }
    }
    const exp = pkg.exports;
    if (typeof exp === 'string') candidates.push(exp);
  }

  // Common entrypoints + config files.
  candidates.push(
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
    'src/main.py',
    'src/cli.ts',
    'src/cli.js',
    'cmd/main.go',
    'main.go',
    'app',
    'pages',
    'tsconfig.json',
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'next.config.mjs',
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const rel = c.replace(/^\.\//, '');
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (await pathExists(path.join(root, rel))) {
      out.push(rel);
      if (out.length >= 8) break;
    }
  }
  return out;
}

/** Workspace package dirs from package.json + pnpm-workspace.yaml, shallowly resolved. */
async function collectWorkspaces(
  root: string,
  pkg: Record<string, unknown> | undefined,
): Promise<string[]> {
  const patterns: string[] = [];

  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    for (const p of ws) if (typeof p === 'string') patterns.push(p);
  } else if (ws && typeof ws === 'object') {
    const packages = (ws as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      for (const p of packages) if (typeof p === 'string') patterns.push(p);
    }
  }

  // pnpm-workspace.yaml: parse the `packages:` list by hand (no YAML dep available).
  const pnpmWs = await readTextOr(path.join(root, 'pnpm-workspace.yaml'));
  if (pnpmWs) patterns.push(...parsePnpmPackages(pnpmWs));

  if (!patterns.length) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue; // ignore negations — shallow resolution only
    // A glob like `packages/*` → existing child dirs containing a package.json.
    const base = pattern.replace(/\/\*\*?$/, '').replace(/\*.*$/, '');
    if (pattern.includes('*')) {
      for (const child of await listDir(path.join(root, base))) {
        const rel = path.posix.join(base, child);
        if (seen.has(rel)) continue;
        if (await pathExists(path.join(root, rel, 'package.json'))) {
          seen.add(rel);
          out.push(rel);
        }
      }
    } else if (!seen.has(pattern) && (await pathExists(path.join(root, pattern, 'package.json')))) {
      seen.add(pattern);
      out.push(pattern);
    }
  }
  return out;
}

/** Pull the `packages:` YAML list out of pnpm-workspace.yaml without a YAML parser. */
function parsePnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (m && m[1]) {
        out.push(m[1].trim());
      } else if (line.trim() && !/^\s/.test(line)) {
        break; // next top-level key ends the list
      }
    }
  }
  return out;
}

async function hasEnvFiles(root: string): Promise<boolean> {
  for (const entry of await listDir(root)) {
    if (entry === '.env' || entry.startsWith('.env.')) return true;
  }
  return false;
}

async function firstExistingDir(root: string, dirs: string[]): Promise<string | undefined> {
  for (const d of dirs) {
    if (await pathExists(path.join(root, d))) return d;
  }
  return undefined;
}

async function detectCI(root: string): Promise<boolean> {
  const workflows = await listDir(path.join(root, '.github', 'workflows'));
  if (workflows.some((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) return true;
  if (await pathExists(path.join(root, '.gitlab-ci.yml'))) return true;
  if (await pathExists(path.join(root, '.circleci'))) return true;
  if (await pathExists(path.join(root, 'azure-pipelines.yml'))) return true;
  return false;
}

/** First of `names` that exists with non-empty trimmed content; returns it trimmed. */
async function firstNonEmpty(root: string, names: string[]): Promise<string | undefined> {
  for (const n of names) {
    const content = (await readTextOr(path.join(root, n))).trim();
    if (content) return content;
  }
  return undefined;
}
