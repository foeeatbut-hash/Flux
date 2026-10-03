/** Только названия команд редактора: пути, параметры и текст сюда не попадают. */
const OPERATIONS = new Set([
  'windows-office:invoke', 'windows-files:invoke',
  'pdf:consume-pending', 'pdf:read-file', 'pdf:is-untitled', 'pdf:validate-text-edits',
  'pdf:list-edit-fonts', 'pdf:can-draw-text', 'pdf:list-page-images', 'pdf:list-static-form-fills',
  'pdf:page-image-png', 'pdf:page-preview-png', 'pdf:get-username', 'pdf:list-signatures',
  'pdf:add-signature', 'pdf:remove-signature', 'pdf:save', 'pdf:insert-blank-page',
  'pdf:set-page-size', 'pdf:crop-pages', 'pdf:dirty-changed', 'pdf:close-save-result', 'pdf:save-as-result',
  'workbook:select', 'workbook:read-range', 'workbook:read-formulas', 'workbook:recalc',
  'workbook:read-media', 'workbook:read-pivot-definition', 'workbook:close', 'workbook:csv-save-confirm',
  'sheets:consume-new-blank', 'sheets:has-queued-workbook', 'sheets:consume-headless-export',
  'workbook:save', 'workbook:save-edits-begin', 'workbook:save-edits-chunk', 'workbook:save-edits-abort',
  'workbook:write-recovery', 'workbook:pending-edits', 'workbook:close-save-result', 'workbook:recovery-prompt-reply',
  'sheets:mcp-ready',
]);
export const isOfficeOperation = (value: unknown): value is string => typeof value === 'string' && OPERATIONS.has(value);
export interface OfficeHostDiagnostic {
  app: 'pdf' | 'sheets'; action: 'open' | 'invoke' | 'send' | 'copy' | 'close';
  operation: string; unknownChannel?: string; phase: 'start' | 'end'; durationMs?: number;
  outcome?: 'ok' | 'error' | 'cancelled' | 'conflict' | 'skipped'; error?: string; code?: string;
}
