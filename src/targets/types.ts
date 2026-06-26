import type { HarnessSpec, TargetId } from '../config/canonical.js';

export type Capability =
  | 'instructions'
  | 'commands'
  | 'subagents'
  | 'hooks'
  | 'mcp'
  | 'permissions'
  | 'modes'
  | 'outputStyles'
  | 'skills'
  | 'ignore';

/** How well a target supports a capability natively. */
export type Support = 'native' | 'shim' | 'codegen' | 'none';

export interface FileOutput {
  /** Path relative to the projection output root (the project root). */
  path: string;
  /** Contents of a generated file (mutually exclusive with `symlinkTo`/`copyFrom`). */
  contents?: string;
  /** Path (relative to output root) this file should symlink to. */
  symlinkTo?: string;
  /** Absolute source path to copy verbatim (for binary skill assets). */
  copyFrom?: string;
  capability: Capability;
  scope: 'project' | 'user';
  /** Human-readable note (e.g. where a global config must be placed by hand). */
  note?: string;
}

export interface ProjectionResult {
  files: FileOutput[];
  /** Degradations, unsupported features, manual steps. */
  warnings: string[];
}

export interface Adapter {
  id: TargetId;
  title: string;
  homepage: string;
  capabilities: Record<Capability, Support>;
  project(spec: HarnessSpec): ProjectionResult;
}

export const CAPABILITIES: Capability[] = [
  'instructions',
  'commands',
  'subagents',
  'hooks',
  'mcp',
  'permissions',
  'modes',
  'outputStyles',
  'skills',
  'ignore',
];
