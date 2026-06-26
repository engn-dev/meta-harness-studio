import { describe, it, expect } from 'vitest';
import {
  toClaudeMcp,
  toRooStyleMcp,
  toOpenCodeMcp,
  toCodexMcpToml,
  toPiMcpExtension,
} from '../src/mcp/transpile.js';
import type { McpServer } from '../src/config/canonical.js';

const stdio: McpServer = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
  headers: {},
  scope: 'project',
  enabled: true,
};

const http: McpServer = {
  name: 'sentry',
  transport: 'http',
  args: [],
  env: {},
  url: 'https://mcp.sentry.dev/sse',
  headers: {},
  bearerTokenEnvVar: 'SENTRY_TOKEN',
  scope: 'project',
  enabled: true,
};

describe('MCP transpilers — each tool genuinely differs', () => {
  it('Claude Code: JSON mcpServers; http gets type+synthesized Authorization', () => {
    expect(toClaudeMcp([stdio, http])).toEqual({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        },
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.dev/sse',
          headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
        },
      },
    });
  });

  it('Codex: TOML [mcp_servers.<name>]; http uses bearer_token_env_var', () => {
    const toml = toCodexMcpToml([stdio, http]);
    expect(toml).toContain('[mcp_servers.github]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "@modelcontextprotocol/server-github"]');
    expect(toml).toContain('env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }');
    expect(toml).toContain('[mcp_servers.sentry]');
    expect(toml).toContain('url = "https://mcp.sentry.dev/sse"');
    expect(toml).toContain('bearer_token_env_var = "SENTRY_TOKEN"');
  });

  it('OpenCode: command merged into ONE array, `environment` not `env`, `enabled` flag', () => {
    expect(toOpenCodeMcp([stdio])).toEqual({
      github: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-github'],
        environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        enabled: true,
      },
    });
    expect(toOpenCodeMcp([http])).toEqual({
      sentry: {
        type: 'remote',
        url: 'https://mcp.sentry.dev/sse',
        headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
        enabled: true,
      },
    });
  });

  it('Cline/Kilo (Roo lineage): mcpServers + disabled + alwaysAllow', () => {
    expect(toRooStyleMcp([stdio])).toEqual({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
          disabled: false,
          alwaysAllow: [],
        },
      },
    });
  });

  it('Pi: code-gen TypeScript extension that honors the enabled flag', () => {
    const ext = toPiMcpExtension([stdio]);
    expect(ext).toContain('export const mcpServers');
    expect(ext).toContain('"transport": "stdio"');
    expect(ext).toContain('export default extension');
    expect(ext).toContain('activate');
    // Pi is code-gen, so unlike the JSON/TOML targets it CAN carry enabled state.
    expect(ext).toContain('"enabled": true');
    expect(ext).toContain('if (!server.enabled) continue;');

    const off = toPiMcpExtension([{ ...stdio, enabled: false }]);
    expect(off).toContain('"enabled": false');
  });

  it('disabled servers are dropped from formats with no off-switch (Claude, Codex), flagged where one exists', () => {
    const off: McpServer = { ...stdio, enabled: false };
    // Claude .mcp.json / Codex config.toml have no `disabled` field — a disabled
    // server must be omitted, not emitted as active.
    expect(toClaudeMcp([off]).mcpServers).toEqual({});
    expect(toCodexMcpToml([off])).toBe('');
    // Roo lineage and OpenCode carry the off-state natively, so they keep the entry.
    expect((toRooStyleMcp([off]).mcpServers.github as { disabled: boolean }).disabled).toBe(true);
    expect((toOpenCodeMcp([off]).github as { enabled: boolean }).enabled).toBe(false);
    // A disabled server alongside an active one drops only the disabled one.
    expect(Object.keys(toClaudeMcp([off, http]).mcpServers)).toEqual(['sentry']);
  });
});
