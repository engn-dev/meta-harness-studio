/**
 * Curated `dependency/signal → MCP server` table.
 *
 * There is no standard for "which MCP server does this stack need" and registries
 * can't answer it (their only filter is a substring match on server names), so we
 * own a small, auditable, conservative table. Matches are high-confidence only;
 * results are rendered as COMMENTED opt-in blocks + a checklist, never live.
 *
 * Env values are `${ENV}` references exclusively — `detectLiteralSecrets` is the
 * backstop, but the table must never carry a literal in the first place.
 */
import type { DetectedMcpServer, RepoSignals } from './types.js';

interface ServerRule {
  /** Server key. */
  name: string;
  /** Lowercased dependency substrings that trigger this server (exact-ish package names). */
  deps?: string[];
  /** Non-dependency signal that triggers it. */
  signal?: (s: RepoSignals) => boolean;
  build: () => DetectedMcpServer;
}

const npx = (pkg: string, extra: string[] = []): { command: string; args: string[] } => ({
  command: 'npx',
  args: ['-y', pkg, ...extra],
});

const RULES: ServerRule[] = [
  {
    name: 'github',
    deps: ['@octokit/rest', 'octokit', '@octokit/core'],
    signal: (s) => s.hasGithubDir,
    build: () => ({
      name: 'github',
      transport: 'stdio',
      ...npx('@modelcontextprotocol/server-github'),
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      reason: 'GitHub repository / Octokit dependency',
      requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    }),
  },
  {
    name: 'postgres',
    deps: ['pg', 'postgres', 'postgresql', 'asyncpg', 'psycopg2', 'psycopg2-binary', 'psycopg'],
    build: () => ({
      name: 'postgres',
      transport: 'stdio',
      ...npx('@modelcontextprotocol/server-postgres', ['${DATABASE_URL}']),
      env: {},
      reason: 'PostgreSQL client dependency',
      requiredEnv: ['DATABASE_URL'],
    }),
  },
  {
    name: 'redis',
    deps: ['redis', 'ioredis'],
    build: () => ({
      name: 'redis',
      transport: 'stdio',
      ...npx('@modelcontextprotocol/server-redis', ['${REDIS_URL}']),
      env: {},
      reason: 'Redis client dependency',
      requiredEnv: ['REDIS_URL'],
    }),
  },
  {
    name: 'playwright',
    deps: ['@playwright/test', 'playwright'],
    build: () => ({
      name: 'playwright',
      transport: 'stdio',
      ...npx('@playwright/mcp@latest'),
      env: {},
      reason: 'Playwright browser-automation dependency',
      requiredEnv: [],
    }),
  },
  {
    name: 'puppeteer',
    deps: ['puppeteer', 'puppeteer-core'],
    build: () => ({
      name: 'puppeteer',
      transport: 'stdio',
      ...npx('@modelcontextprotocol/server-puppeteer'),
      env: {},
      reason: 'Puppeteer browser-automation dependency',
      requiredEnv: [],
    }),
  },
  {
    name: 'stripe',
    deps: ['stripe'],
    build: () => ({
      name: 'stripe',
      transport: 'stdio',
      ...npx('@stripe/mcp', ['--tools=all']),
      env: { STRIPE_SECRET_KEY: '${STRIPE_SECRET_KEY}' },
      reason: 'Stripe SDK dependency',
      requiredEnv: ['STRIPE_SECRET_KEY'],
    }),
  },
  {
    name: 'sentry',
    deps: ['@sentry/node', '@sentry/react', '@sentry/nextjs', '@sentry/browser', 'sentry-sdk'],
    build: () => ({
      name: 'sentry',
      transport: 'stdio',
      ...npx('@sentry/mcp-server'),
      env: { SENTRY_AUTH_TOKEN: '${SENTRY_AUTH_TOKEN}' },
      reason: 'Sentry SDK dependency',
      requiredEnv: ['SENTRY_AUTH_TOKEN'],
    }),
  },
];

/** Max servers to suggest — tool-list bloat past ~5 measurably degrades agents. */
const MAX_SERVERS = 5;

/**
 * Infer candidate MCP servers from a repo's dependencies + signals. Conservative
 * and deduped; capped at {@link MAX_SERVERS}. Order follows {@link RULES}.
 */
export function inferMcpServers(signals: RepoSignals): DetectedMcpServer[] {
  const deps = new Set(signals.dependencies.map((d) => d.toLowerCase()));
  const out: DetectedMcpServer[] = [];
  for (const rule of RULES) {
    const depHit = rule.deps?.some((d) => deps.has(d.toLowerCase())) ?? false;
    const signalHit = rule.signal?.(signals) ?? false;
    if (depHit || signalHit) out.push(rule.build());
    if (out.length >= MAX_SERVERS) break;
  }
  return out;
}
