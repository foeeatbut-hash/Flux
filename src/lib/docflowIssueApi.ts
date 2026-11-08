/** Запросы окна «Выпустить…» к серверу (server/routes/docflowIssue.ts). */
import { docflowCall } from './docflowApi';

export interface IssueRowView {
  itemId: string; linkId: string; reason: string; date: string; sha256: string; busy: boolean;
  revision: string; cipher: string; title: string; fileName: string; status: string; problems: string[]; notes: string[];
}
export interface IssuePlanView { id: string; projectId: string; rows: IssueRowView[]; ok: boolean; expiresAt: string }
export interface IssueResultView { id: string; count: number; repeated?: boolean; issues: Array<{ itemId: string; revision: string; linkId: string }> }
export interface IssueStateView { id: string; projectId: string; state: 'preview' | 'applied' | 'undone'; rows: IssueRowView[]; result: IssueResultView | null }
export interface IssueRowInput { itemId: string; linkId: string; reason: string; date: string; sha256: string; busy: boolean }

export const planIssue = (projectId: string, rows: IssueRowInput[]) => docflowCall<IssuePlanView>('POST', '/api/docflow/issue/plan', { projectId, rows });
export const applyIssue = (projectId: string, planId: string, hashes: Record<string, string>) => docflowCall<IssueResultView>('POST', '/api/docflow/issue/apply', { projectId, planId, hashes });
export const undoIssue = (projectId: string, planId: string) => docflowCall<{ ok: boolean }>('POST', '/api/docflow/issue/undo', { projectId, planId });
export const lastIssue = (projectId: string) => docflowCall<IssueStateView | null>('GET', `/api/docflow/issue/last?projectId=${encodeURIComponent(projectId)}`);
