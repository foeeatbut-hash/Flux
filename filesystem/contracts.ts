export interface WindowsFileRef { rootId: string; relativePath: string; draftId?: string }
export type WindowsKnownFolder = 'desktop' | 'documents' | 'downloads' | 'custom';
export interface WindowsRoot { id: string; name: string; kind: WindowsKnownFolder; available: boolean; network?: boolean }
export interface WindowsFileEntry {
  name: string; relativePath: string; storage: 'flux' | 'windows'; draftId?: string; kind: 'file' | 'directory' | 'link' | 'other';
  fileId: string; size: number; modifiedAt: string; linked: boolean;
}
export interface WindowsFileContent extends WindowsFileEntry { base64: string; sha256: string }
export interface WindowsFileMetadata {
  fileId: string; tags: string[]; projectIds: string[]; revision: string; responsible: string;
  history: { at: string; action: string; relativePath: string; sha256?: string }[];
}
export interface WindowsFilesChanged { rootId: string; relativePath: string; rescan: true }
export type WindowsFilesRequest =
  | { action: 'roots' }
  | { action: 'draftTrash' }
  | { action: 'restoreDraft'; ref: WindowsFileRef }
  | { action: 'addRoot' }
  | { action: 'list'; ref: WindowsFileRef; offset?: number; limit?: number }
  | { action: 'read'; ref: WindowsFileRef }
  | { action: 'icon'; ref: WindowsFileRef }
  | { action: 'write'; ref: WindowsFileRef; base64: string; baseSha256: string }
  | { action: 'publish'; parent: WindowsFileRef; name: string; base64: string; draftId: string }
  | { action: 'createDraft'; parent: WindowsFileRef; name: string; base64: string }
  | { action: 'publishDraft'; ref: WindowsFileRef }
  | { action: 'mkdir'; parent: WindowsFileRef; name: string }
  | { action: 'rename'; ref: WindowsFileRef; name: string }
  | { action: 'copy' | 'move'; ref: WindowsFileRef; parent: WindowsFileRef; name: string; baseSha256?: string }
  | { action: 'trash'; ref: WindowsFileRef; baseSha256?: string }
  | { action: 'reveal' | 'open'; ref: WindowsFileRef }
  | { action: 'metadata'; ref: WindowsFileRef }
  | { action: 'setMetadata'; ref: WindowsFileRef; metadata: Pick<WindowsFileMetadata, 'tags' | 'projectIds' | 'revision' | 'responsible'> }
  | { action: 'watch' | 'unwatch'; ref: WindowsFileRef };
export type WindowsFilesResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
export const WINDOWS_FILES_CHANNEL = 'windows-files:invoke';
export const WINDOWS_FILES_CHANGED = 'windows-files:changed';
