export const CONTRACT_VERSION = 1 as const;
export const resources = ['project', 'equipment', 'tag', 'specification', 'catalog'] as const;
export type Resource = typeof resources[number];
export interface LaunchContext {
  projectId: string | null;
  entry: 'start' | 'equipment' | 'tag';
  entityId: string | null;
}
export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  contractVersion: number;
  entries: Array<'start' | 'equipment' | 'tag'>;
  reads: Resource[];
  logic: string;
}
export interface Parameter { group: string; key: string; value: string; unit: string }
export interface TagData { id: string; identifier: string; name: string; parentId: string | null }
export interface EquipmentData {
  id: string; name: string; itemCode: string; equipType: string; version: number;
  params: Parameter[]; tags: TagData[];
  composition: Array<{ id: string; name: string; itemCode: string; parentId: string | null }>;
}
export interface ReadData {
  project: { id: string; name: string; code: string } | null;
  equipment: EquipmentData | null;
  tag: TagData | null;
  specification: { rows: TagData[] };
  catalog: { families: Array<{ id: string; name: string; code: string; classId: string }> };
}
export interface ReadRequest {
  flux: 'module'; v: 1; session: string; id: string; type: 'read';
  resource: Resource; entityId?: string;
}
export type BridgeError = 'READ_ONLY' | 'DENIED' | 'NO_PROJECT' | 'FAILED' | 'LIMIT';
export type HostMessage =
  | { flux: 'module'; v: 1; session: string; type: 'event'; event: 'opened' | 'project-changed' | 'changed'; context: LaunchContext; theme: ThemeTokens }
  | { flux: 'module'; v: 1; session: string; type: 'result'; id: string; resource: Resource; data: ReadData[Resource] }
  | { flux: 'module'; v: 1; session: string; type: 'error'; id: string; code: BridgeError };
export type ThemeTokens = Record<
  '--flux-surface' | '--flux-bg' | '--flux-hover' | '--flux-sel' | '--flux-line' | '--flux-text' | '--flux-text-muted' | '--flux-accent',
  string
>;
export const themeKeys: Array<keyof ThemeTokens> = [
  '--flux-surface', '--flux-bg', '--flux-hover', '--flux-sel', '--flux-line', '--flux-text', '--flux-text-muted', '--flux-accent',
];
export interface ModuleApi {
  flux: {
    read<R extends Resource>(resource: R, entityId?: string): Promise<ReadData[R]>;
    on(event: 'changed', listener: () => void | Promise<void>): () => void;
  };
  state: Record<string, unknown>;
  calc: { out: Record<string, unknown> };
}
export type ModuleReader = <R extends Resource>(resource: R, entityId?: string) => Promise<ReadData[R]>;
export interface ModuleOutput {
  state: ModuleApi['state'];
  calc: ModuleApi['calc'];
}
