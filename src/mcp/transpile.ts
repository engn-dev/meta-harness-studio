/**
 * MCP server transpilers.
 *
 * MCP is the one capability with no shared format — every target serializes it
 * differently, so a single canonical definition cannot be symlinked, only
 * transpiled. The divergences are real and load-bearing:
 *   - Claude / Cline / Kilo: JSON `mcpServers`, but Cline/Kilo add `disabled` + `alwaysAllow`
 *   - Codex:                 TOML `[mcp_servers.<name>]`, http uses `bearer_token_env_var`
 *   - OpenCode:              `command` is a SINGLE ARRAY (command+args merged),
 *                            `environment` (not `env`), and an `enabled` flag, type local|remote
 *   - Pi:                    no MCP config key at all -> generate a TypeScript extension
 *
 * Secrets are always emitted as `${ENV}` references, never literals.
 */
import type { McpServer } from '../config/canonical.js';

function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

function emptyToUndef<T extends Record<string, unknown>>(rec: T): T | undefined {
  return Object.keys(rec).length ? rec : undefined;
}

/** http headers including a synthesized Authorization header when a bearer env var is set. */
function httpHeaders(s: McpServer): Record<string, string> {
  const h: Record<string, string> = { ...s.headers };
  const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
  if (s.bearerTokenEnvVar && !hasAuth) {
    h['Authorization'] = `Bearer \${${s.bearerTokenEnvVar}}`;
  }
  return h;
}

export function projectScoped(servers: McpServer[]): McpServer[] {
  return servers.filter((s) => s.scope === 'project');
}

/** Servers a tool should actually run. Formats with no `disabled`/`enabled` field
 *  (Claude `.mcp.json`, Codex `config.toml`) must omit disabled servers entirely —
 *  emitting them would silently activate a server the harness marked off. */
function activeOnly(servers: McpServer[]): McpServer[] {
  return servers.filter((s) => s.enabled);
}

// ---------------------------------------------------------------------------
// Claude Code — .mcp.json
// ---------------------------------------------------------------------------
export function toClaudeMcp(servers: McpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of activeOnly(servers)) {
    if (s.transport === 'stdio') {
      mcpServers[s.name] = clean({
        command: s.command,
        args: s.args.length ? s.args : undefined,
        env: emptyToUndef(s.env),
      });
    } else {
      mcpServers[s.name] = clean({
        type: 'http',
        url: s.url,
        headers: emptyToUndef(httpHeaders(s)),
      });
    }
  }
  return { mcpServers };
}

// ---------------------------------------------------------------------------
// Cline / Kilo Code — Roo-lineage JSON (mcpServers + disabled + alwaysAllow)
// ---------------------------------------------------------------------------
export function toRooStyleMcp(servers: McpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.transport === 'stdio') {
      mcpServers[s.name] = clean({
        command: s.command,
        args: s.args.length ? s.args : undefined,
        env: emptyToUndef(s.env),
        disabled: !s.enabled,
        alwaysAllow: [] as string[],
      });
    } else {
      mcpServers[s.name] = clean({
        url: s.url,
        headers: emptyToUndef(httpHeaders(s)),
        disabled: !s.enabled,
        alwaysAllow: [] as string[],
      });
    }
  }
  return { mcpServers };
}

// ---------------------------------------------------------------------------
// OpenCode — opencode.json `mcp` (command-as-array, `environment`, `enabled`)
// ---------------------------------------------------------------------------
export function toOpenCodeMcp(servers: McpServer[]): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.transport === 'stdio') {
      mcp[s.name] = clean({
        type: 'local',
        command: [s.command as string, ...s.args],
        environment: emptyToUndef(s.env),
        enabled: s.enabled,
      });
    } else {
      mcp[s.name] = clean({
        type: 'remote',
        url: s.url,
        headers: emptyToUndef(httpHeaders(s)),
        enabled: s.enabled,
      });
    }
  }
  return mcp;
}

// ---------------------------------------------------------------------------
// Codex — config.toml [mcp_servers.<name>] (hand-rolled for byte-predictability)
// ---------------------------------------------------------------------------
function tomlString(s: string): string {
  // TOML basic strings share JSON's quote/backslash escaping for our value set.
  return JSON.stringify(s);
}
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}
function tomlStringArray(a: string[]): string {
  return `[${a.map(tomlString).join(', ')}]`;
}
function tomlInlineTable(obj: Record<string, string>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`);
  return `{ ${parts.join(', ')} }`;
}

export function toCodexMcpToml(servers: McpServer[]): string {
  const blocks: string[] = [];
  for (const s of activeOnly(servers)) {
    const lines = [`[mcp_servers.${tomlKey(s.name)}]`];
    if (s.transport === 'stdio') {
      lines.push(`command = ${tomlString(s.command as string)}`);
      if (s.args.length) lines.push(`args = ${tomlStringArray(s.args)}`);
      if (Object.keys(s.env).length) lines.push(`env = ${tomlInlineTable(s.env)}`);
    } else {
      lines.push(`url = ${tomlString(s.url as string)}`);
      if (s.bearerTokenEnvVar) {
        lines.push(`bearer_token_env_var = ${tomlString(s.bearerTokenEnvVar)}`);
      }
      if (Object.keys(s.headers).length) {
        lines.push(`http_headers = ${tomlInlineTable(s.headers)}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Pi — no MCP config; generate a TypeScript extension (code-gen path)
// ---------------------------------------------------------------------------
export function toPiMcpExtension(servers: McpServer[]): string {
  const data = servers.map((s) =>
    s.transport === 'stdio'
      ? { name: s.name, transport: 'stdio', command: s.command, args: s.args, env: s.env, enabled: s.enabled }
      : {
          name: s.name,
          transport: 'http',
          url: s.url,
          headers: httpHeaders(s),
          bearerTokenEnvVar: s.bearerTokenEnvVar,
          enabled: s.enabled,
        },
  );
  return `/**
 * meta-harness-studio — generated MCP extension for Pi.
 *
 * Pi has no declarative MCP config block; MCP is wired in through a TypeScript
 * extension. The server definitions below are projected from .harness/mcp.toml.
 *
 * INTEGRATION SEAM: Pi's extension API moves fast (~50k stars in months). Verify
 * the registration hook against the current pi.dev docs for your installed
 * version, then connect each server in \`activate()\` below.
 */

export const mcpServers = ${JSON.stringify(data, null, 2)} as const;

const extension = {
  name: 'meta-harness-mcp',
  async activate(ctx: any): Promise<void> {
    for (const server of mcpServers) {
      if (!server.enabled) continue;
      // Wire to your Pi build's MCP bridge, e.g.:
      //   await ctx.mcp?.addServer(server);
      ctx.registerMcpServer?.(server);
    }
  },
};

export default extension;
`;
}

export function jsonFile(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}
