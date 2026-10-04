export const LAYERS = ['unit', 'component', 'api-db', 'browser-live', 'windows-native', 'portable'] as const;
export type Layer = typeof LAYERS[number];
export const PLATFORMS = ['any', 'win32', 'linux', 'darwin'] as const;
export type Platform = typeof PLATFORMS[number];
export const CONNECTION_STATUSES = ['implemented', 'conditional', 'planned'] as const;
export type ConnectionStatus = typeof CONNECTION_STATUSES[number];

export interface PrerequisiteEnv { kind: 'env'; name: string; value?: string }
export interface PrerequisiteFile { kind: 'file'; path: string }
export type Prerequisite = PrerequisiteEnv | PrerequisiteFile;
export interface VerificationSuite {
  id: string; path: string; layer: Layer; platform: Platform; resources: string[];
  prerequisites: Prerequisite[]; timeoutMs: number; external?: boolean;
}
export interface VerificationCheck { suite: string; layer: Layer; claims: string[] }
export interface ManualCheck { layer: Layer; scenario: string; expected: string[] }
export interface VerificationProgram { id: string; label: string; routes: string[]; sources: string[] }
export interface VerificationAction {
  id: string; program: string; label: string; sources: string[]; triggers: string[];
  risk: 'critical' | 'normal' | 'cosmetic'; expected: string[];
  checks: VerificationCheck[]; manual: ManualCheck[];
}
export interface VerificationConnection {
  id: string; from: string; to: string; status: ConnectionStatus; sources: string[];
  expected: string[]; checks: VerificationCheck[]; manual: ManualCheck[];
}
export interface VerificationManifest {
  version: 1; group: string; programs: VerificationProgram[]; suites: VerificationSuite[];
  actions: VerificationAction[]; connections: VerificationConnection[];
}

export type SuiteStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP';
export interface SuiteResult {
  id: string; group: string; path: string; layer: Layer; platform: Platform;
  status: SuiteStatus; durationMs: number; exitCode: number | null;
  reason?: string; output?: string;
}
export interface ClaimResult {
  claim: string; suite: string; layer: Layer; status: SuiteStatus;
}
export interface ManualResult { layer: Layer; scenario: string; expected: string[]; status: 'NOT_RUN' }
export interface VerificationReport {
  schemaVersion: 1; startedAt: string; finishedAt: string; group?: string;
  appVersion: string; platform: string; nodeVersion: string;
  /** SHA-256 over the sorted, scoped source set at run start. */
  scopedSourceDigest: string;
  finishedScopedSourceDigest: string;
  sourceChangedDuringRun: boolean;
  suites: SuiteResult[];
  actions: Array<{ id: string; program: string; claims: ClaimResult[]; manual: ManualResult[]; status: 'PARTIAL' | 'UNTESTED' }>;
  connections: Array<{ id: string; from: string; to: string; status: ConnectionStatus; claims: ClaimResult[]; manual: ManualResult[]; coverage: 'IN_SCOPE' | 'EXCLUDED_PLANNED' }>;
}
