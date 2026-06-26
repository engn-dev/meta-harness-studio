import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthor } from '../src/commands/author.js';
import { scanRepo } from '../src/author/scan.js';
import { renderHarnessFiles } from '../src/author/render.js';
import { generateEvalTasks } from '../src/author/evalgen.js';
import { loadFromHarnessDir } from '../src/config/load.js';
import { detectStaleScripts } from '../src/engine/staleness.js';
import { detectLiteralSecrets } from '../src/config/secrets.js';
import type { RepoDigest } from '../src/author/types.js';

let dir = '';

/** A realistic JS repo: build/test/lint/typecheck scripts, pg + playwright deps, .env, dist/. */
async function scaffoldRepo(): Promise<void> {
  const pkg = {
    name: 'acme-api',
    description: 'A small REST API for ACME widgets.',
    scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
    dependencies: { express: '^4', pg: '^8', react: '^18' },
    devDependencies: { typescript: '^5', vitest: '^1', '@playwright/test': '^1' },
  };
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await fs.writeFile(path.join(dir, 'src', 'index.ts'), "console.log('hi')\n");
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=xyz\n');
  await fs.writeFile(path.join(dir, 'dist', 'index.js'), 'compiled\n');
  await fs.writeFile(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
  await fs.writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mhs-author-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('harness author (Phase 0)', () => {
  it('authors a harness that passes the validation gate and both guards', async () => {
    await scaffoldRepo();
    const code = await runAuthor(dir);
    expect(code).toBe(0);

    const harnessDir = path.join(dir, '.harness');
    const { spec, errors } = await loadFromHarnessDir(harnessDir, dir);
    expect(errors).toHaveLength(0);
    expect(spec).toBeDefined();

    // The two guards that `verify` enforces must be clean by construction.
    expect(await detectStaleScripts(spec!)).toHaveLength(0);
    expect(detectLiteralSecrets(spec!.mcp)).toHaveLength(0);
  });

  it('writes the real build command into AGENTS.md (not an invented one)', async () => {
    await scaffoldRepo();
    await runAuthor(dir);
    const agents = await fs.readFile(path.join(dir, '.harness', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('npm run build');
    expect(agents).toContain('npm test');
    // Never references a script the project doesn't define.
    expect(agents).not.toMatch(/npm run (deploy|release|start)/);
  });

  it('infers MCP servers from the stack and renders them commented (never live)', async () => {
    await scaffoldRepo();
    const digest = await scanRepo(dir);
    const names = digest.mcpServers.map((s) => s.name).sort();
    expect(names).toContain('postgres'); // pg
    expect(names).toContain('playwright'); // @playwright/test
    expect(names).toContain('github'); // .github/

    await runAuthor(dir);
    const mcp = await fs.readFile(path.join(dir, '.harness', 'mcp.toml'), 'utf8');
    expect(mcp).toContain('# [servers.postgres]');
    // Nothing live → the loaded spec has zero MCP servers (projection untouched).
    const { spec } = await loadFromHarnessDir(path.join(dir, '.harness'), dir);
    expect(spec!.mcp).toHaveLength(0);
  });

  it('authors a build-output protection rule as warn, never deny', async () => {
    await scaffoldRepo();
    await runAuthor(dir);
    const { spec } = await loadFromHarnessDir(path.join(dir, '.harness'), dir);
    const generatedRule = spec!.enforce.find((r) => r.id === 'warn-edit-generated');
    expect(generatedRule?.action).toBe('warn');
    // The known-safe env deny is still present.
    expect(spec!.enforce.find((r) => r.id === 'block-env-read')?.action).toBe('deny');
  });

  it('preserves existing files unless --force', async () => {
    await scaffoldRepo();
    await runAuthor(dir);
    const agentsPath = path.join(dir, '.harness', 'AGENTS.md');
    await fs.writeFile(agentsPath, '# hand-edited\n');

    await runAuthor(dir); // default: preserve
    expect(await fs.readFile(agentsPath, 'utf8')).toBe('# hand-edited\n');

    await runAuthor(dir, { force: true }); // force: overwrite
    expect(await fs.readFile(agentsPath, 'utf8')).toContain('## Commands');
  });
});

describe('hardening (adversarial inputs)', () => {
  it('does not break verify on a repo with a dotted/odd script name', async () => {
    // `ci.test` would be mis-parsed by detectStaleScripts' [a-zA-Z0-9:_-] capture
    // (→ "ci"), so the author must not emit `npm run ci.test`.
    const pkg = {
      name: 'odd-scripts',
      scripts: { build: 'tsc', 'ci.test': 'vitest run', 'lint web': 'eslint .' },
    };
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const code = await runAuthor(dir);
    expect(code).toBe(0); // would be 1 if a stale ref were emitted

    const agents = await fs.readFile(path.join(dir, '.harness', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('npm run build');
    expect(agents).not.toContain('ci.test');
    expect(agents).not.toContain('lint web');

    const { spec } = await loadFromHarnessDir(path.join(dir, '.harness'), dir);
    expect(await detectStaleScripts(spec!)).toHaveLength(0);
  });

  it('never executes a backtick needle from a malicious filename (no shell injection)', async () => {
    const harnessDir = path.join(dir, '.harness');
    await fs.mkdir(harnessDir, { recursive: true });
    await fs.writeFile(path.join(harnessDir, 'AGENTS.md'), '# t\n\n- Never commit secrets.\n');
    const sentinel = path.join(dir, 'PWNED');

    const digest = {
      name: 't',
      root: dir,
      languages: [],
      frameworks: [],
      commands: [],
      // A key path crafted to run a command if interpolated into `sh -c "...$NEEDLE..."`.
      keyPaths: ['x`touch ' + sentinel + '`y'],
      workspaces: [],
      mcpServers: [],
      signals: { hasEnvFiles: false, hasGithubDir: false, hasCI: false, dependencies: [] },
    } satisfies RepoDigest;

    await generateEvalTasks(digest, harnessDir, dir);
    // The backtick needle is rejected before any shell sees it → no side effect.
    const pwned = await fs
      .access(sentinel)
      .then(() => true)
      .catch(() => false);
    expect(pwned).toBe(false);
  });

  it('caps a very large imported instruction file so AGENTS.md stays bounded', async () => {
    const huge = Array.from({ length: 400 }, (_, i) => `imported line ${i}`).join('\n');
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"big","scripts":{"build":"tsc"}}');
    await fs.writeFile(path.join(dir, 'AGENTS.md'), huge);

    await runAuthor(dir);
    const agents = await fs.readFile(path.join(dir, '.harness', 'AGENTS.md'), 'utf8');
    const lineCount = agents.split('\n').length;
    expect(lineCount).toBeLessThan(220);
    expect(agents).toContain('imported instructions truncated');
  });
});

describe('eval-gen validate-then-keep', () => {
  it('keeps canaries that hold and DROPS ones whose fact is absent from AGENTS.md', async () => {
    // A harness whose AGENTS.md mentions the build command but NOT the lint command.
    const harnessDir = path.join(dir, '.harness');
    await fs.mkdir(harnessDir, { recursive: true });
    await fs.writeFile(
      path.join(harnessDir, 'AGENTS.md'),
      '# t\n\n## Commands\n- Build: `npm run build`\n\n## Conventions\n- Never commit secrets.\n',
    );

    const digest = {
      name: 't',
      root: dir,
      languages: [],
      frameworks: [],
      commands: [
        { kind: 'build', cmd: 'npm run build', script: 'build' },
        { kind: 'lint', cmd: 'npm run lint', script: 'lint' }, // absent from AGENTS.md above
      ],
      keyPaths: [],
      workspaces: [],
      mcpServers: [],
      signals: { hasEnvFiles: false, hasGithubDir: false, hasCI: false, dependencies: [] },
    } satisfies RepoDigest;

    const report = await generateEvalTasks(digest, harnessDir, dir);
    expect(report.kept).toContain('keeps-build-command');
    expect(report.kept).toContain('keeps-secrets-rule');
    // The lint canary fails on the true harness → dropped, not shipped.
    expect(report.dropped.map((d) => d.name)).toContain('keeps-lint-command');
    // A dropped canary leaves no task dir behind.
    expect(
      await fs
        .access(path.join(dir, 'eval', 'search', 'keeps-lint-command'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });
});
