import { docflowCall } from './docflowApi';

export interface KitDocumentItem { id: string; registerId: string; contractorNo: string; ownerNo: string; vendorNo: string; titleRu: string; vdrCode: string; revision: string; status: string; dueDate: string | null }
export interface KitRequirementView { key: string; docType: string; title: string; unit: string; scopeId: string; needed: boolean; problem: string; state: string; hasFile: boolean; item: KitDocumentItem | null }
export interface KitTagView { id: string; identifier: string; classId: string; removed: boolean; items: KitDocumentItem[]; requirements: KitRequirementView[] }
export interface KitDocumentsView {
  tags: KitTagView[]; totals: { needed: number; existing: number; issued: number; overdue: number };
  registers: Array<{ id: string; name: string }>; lastPlanId: string | null;
}
export interface KitPlanRow {
  key: string; tags?: string[]; tagIds: string[]; docType: string; unit: string; scopeId: string;
  necessity?: string; cipher?: string; fileName?: string; titleRu?: string; assignee?: string; dueDate?: string;
  action: 'create' | 'keep' | 'skip'; problem: string;
}
export interface KitRowsPlan { id: string; rows: KitPlanRow[]; expiresAt: string }
export const getKitDocuments = (projectId: string, tagId?: string, stage?: string) =>
  docflowCall<KitDocumentsView>('GET', `/api/docflow/tags?${new URLSearchParams({ projectId, ...(tagId ? { tagId } : {}), ...(stage ? { stage } : {}) })}`);
export const kitPlan = (body: unknown) => docflowCall<KitRowsPlan>('POST', '/api/docflow/kits/plan', body);
export const kitApply = (projectId: string, planId: string) => docflowCall('POST', '/api/docflow/kits/apply', { projectId, planId });
export const kitUndo = (projectId: string, planId: string) => docflowCall('POST', '/api/docflow/kits/undo', { projectId, planId });
