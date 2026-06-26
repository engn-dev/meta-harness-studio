/**
 * Literal-secret detection for MCP env/headers.
 *
 * The contract is "secrets stay as ${ENV} references, never literals" — but a
 * convention nothing checks is just a hope. A value under a secret-named key
 * (TOKEN/KEY/SECRET/...) that carries no `${ENV}` reference is almost certainly a
 * pasted credential about to be committed into generated tool config. We flag it.
 */
import type { McpServer } from './canonical.js';

const SECRETISH_KEY = /(token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|auth|bearer|pat)\b/i;
const ENV_REF = /\$\{[^}]+\}/;

export interface SecretFinding {
  server: string;
  field: string;
  key: string;
}

/** Keys whose value looks like a pasted literal secret rather than an ${ENV} ref. */
export function detectLiteralSecrets(servers: McpServer[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const scan = (server: string, field: string, record: Record<string, string>): void => {
    for (const [key, value] of Object.entries(record)) {
      if (!value || ENV_REF.test(value)) continue;
      if (SECRETISH_KEY.test(key)) findings.push({ server, field, key });
    }
  };
  for (const s of servers) {
    scan(s.name, 'env', s.env);
    scan(s.name, 'headers', s.headers);
  }
  return findings;
}
