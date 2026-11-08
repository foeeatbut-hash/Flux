import { docflowCall } from './docflowApi';
import type { DocLinkDto } from '../../shared/docflow/links';
import type { ProjectFolderBinding } from './projectFolderBindings';

export interface CreateFileRow {
  itemId: string; revision: string; fileName: string; relativePath: string; folderKey: string;
  template: string; format: string; action: 'create' | 'open'; link: DocLinkDto | null; binding: ProjectFolderBinding | null;
}
export interface FileCreatePlan { id: string; projectId: string; rows: CreateFileRow[]; workBinding: ProjectFolderBinding | null; expiresAt: string }
export interface FileCreateResult { id: string; count: number; links: DocLinkDto[]; changes?: Array<{ itemId: string; link: DocLinkDto }> }
export interface FileCreationState extends FileCreatePlan { state: string; result: FileCreateResult | null }
const endpoint = '/api/docflow/create-files';
export const planFileCreation = (body: { projectId: string; itemIds: string[]; format: string; useTemplates: boolean }) => docflowCall<FileCreatePlan>('POST', `${endpoint}/plan`, body);
export const claimFileCreation = (projectId: string, planId: string, files: Array<{ itemId: string; sha256: string; size: number }>) =>
  docflowCall<{ applied?: boolean; result?: FileCreateResult }>('POST', `${endpoint}/claim`, { projectId, planId, files });
export const completeFileCreation = (projectId: string, planId: string) => docflowCall<FileCreateResult>('POST', `${endpoint}/complete`, { projectId, planId });
export const stateFileCreation = (projectId: string, planId: string) => docflowCall<FileCreationState>('GET', `${endpoint}/state?${new URLSearchParams({ projectId, planId })}`);
export const lastFileCreation = (projectId: string, itemId?: string) => docflowCall<FileCreationState | null>('GET', `${endpoint}/state?${new URLSearchParams({ projectId, last: '1', ...(itemId ? { itemId } : {}) })}`);
export const undoFileCreationPlan = (projectId: string, planId: string) => docflowCall<{ files: DocLinkDto[] }>('POST', `${endpoint}/undo-plan`, { projectId, planId });
export const undoFileCreation = (projectId: string, planId: string) => docflowCall('POST', `${endpoint}/undo`, { projectId, planId });
export const cancelFileCreation = (projectId: string, planId: string, prepareOnly = false) => docflowCall('POST', `${endpoint}/cancel`, { projectId, planId, prepareOnly });
