import { useCallback, useEffect, useRef, useState } from 'react';
import FluxCellActionsDialog, { type FluxCellActionAnchor, type FluxCellMergeRequest, type FluxCellMergeConfirmation } from './FluxCellActionsDialog';
import { fieldsFromCatalog, officeDataApi, type OfficeState, type OfficeField } from './fluxData';
import type { OfficeBinding, OfficeHeaderSchema } from '../../lib/officeModel';
import type { HeaderSchemaSyncOptions } from './officeNativeSchema';

interface Options {
  fileId: string;
  projectId: string;
  readOnly: boolean;
  requestState: () => Promise<OfficeState | null>;
  requestNative: (operation: 'merge' | 'formula', payload: unknown) => Promise<any>;
  updateSchema: (schema: OfficeHeaderSchema, options?: HeaderSchemaSyncOptions) => Promise<OfficeState | null>;
  insertBinding: (anchor: FluxCellActionAnchor, binding: OfficeBinding, label: string) => Promise<boolean>;
  onError: (message: string) => void;
  isInlineEditing?: () => boolean;
  resumeFocus?: (anchorId: string, schema: OfficeHeaderSchema) => void;
}

/** Контекстное окно принадлежит дополнению: обычное меню редактора остаётся его собственным. */
export function useFluxCellActions(options: Options) {
  const generation = useRef(0);
  useEffect(() => { generation.current++; setSelection([]); setState(null); setFields([]); }, [options.fileId]);
  const [selection, setSelection] = useState<FluxCellActionAnchor[]>([]);
  const [state, setState] = useState<OfficeState | null>(null);
  const [fields, setFields] = useState<OfficeField[]>([]);
  const [busy, setBusy] = useState(false);
  const open = useCallback(async (payload: any) => {
    if (!Array.isArray(payload?.anchors) || !payload.anchors.length || payload.anchors.length > 2) return;
    const openedGeneration = generation.current;
    setBusy(true);
    try {
      const current = await options.requestState();
      if (!current) throw new Error('Схема документа недоступна.');
      const catalog = await officeDataApi.catalog(options.projectId);
      const selected = payload.anchors.map((anchor: any) => {
        const stored = current.schema.anchors.find((item) => item.id === anchor.anchorId);
        if (!stored) throw new Error('Сначала привяжите параметр к ячейке шапки.');
        return { ...anchor, ...stored, anchorId: stored.id, parts: Array.isArray(anchor.parts) && anchor.parts.length ? anchor.parts : stored.parts };
      });
      if (openedGeneration !== generation.current) return;
      setState(current); setFields(fieldsFromCatalog(catalog)); setSelection(selected);
    } catch (reason: any) { options.onError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [options.fileId, options.projectId, options.requestState]);

  const merge = async (request: FluxCellMergeRequest | FluxCellMergeConfirmation, confirm: boolean) => {
    if (!state || options.readOnly) return { ok: false, error: 'Документ открыт только для просмотра.' };
    const target = state.schema.anchors.find((anchor) => anchor.id === request.targetAnchorId);
    if (!target || request.sourceAnchorIds.some((id) => !state.schema.anchors.some((anchor) => anchor.id === id))) return { ok: false, error: 'Выбранные ячейки больше не найдены.' };
    const schema: OfficeHeaderSchema = { ...state.schema, anchors: state.schema.anchors.filter((anchor) => !request.sourceAnchorIds.includes(anchor.id)).map((anchor) => anchor.id === target.id ? {
      ...anchor, parts: [{ kind: 'union', mode: 'first-match', label: request.outputLabel.trim(), alternatives: request.alternatives.map((binding) => ({ ...binding, anchorId: target.id })) }],
    } : anchor) };
    const response = await options.requestNative('merge', { schema, sourceSchema: state.schema, rows: state.rows || [], targetAnchorId: target.id, sourceAnchorIds: request.sourceAnchorIds,
      ...(confirm ? { confirm: true, previewToken: (request as FluxCellMergeConfirmation).previewToken } : { previewOnly: true }) });
    if (!response?.ok) return response || { ok: false, error: 'Редактор не ответил.' };
    if (confirm) {
      const next = await options.updateSchema(response.schema || schema, { captureNative: true, rows: response.rows || (state.rows || []).map((row) => ({ ...row,
        anchorIds: row.anchorIds.filter((id) => !request.sourceAnchorIds.includes(id)),
        cells: Object.fromEntries(Object.entries(row.cells || {}).filter(([id]) => !request.sourceAnchorIds.includes(id))),
        values: Object.fromEntries(Object.entries(row.values || {}).filter(([id]) => !request.sourceAnchorIds.includes(id))),
      })) });
      if (!next) throw new Error('Колонки объединены, но схема не сохранена. Сохраните документ.');
      setState(next); setSelection([]);
    }
    return response;
  };
  const insert = async (field: OfficeField, anchorId: string) => {
    const anchor = selection.find((item) => item.anchorId === anchorId);
    if (!anchor || !state || options.readOnly) return false;
    const binding: OfficeBinding = { fieldKey: field.fieldKey, sourceId: field.sourceId, entityType: field.entityType, entityId: null, sourceRevision: state.sourceRevision, anchorId, ...(field.unit ? { unit: field.unit } : {}) };
    if (!(await options.insertBinding(anchor, binding, field.displayName))) return false;
    // Во время ввода в ячейке метка остаётся в буфере до Enter; сохранение не прерывает курсор.
    if (options.isInlineEditing?.()) {
      setSelection([]);
      requestAnimationFrame(() => { void options.requestNative('formula', { anchorId, schema: state.schema }).catch((reason) => options.onError(String(reason?.message || reason))); });
      return true;
    }
    const schema: OfficeHeaderSchema = { ...state.schema, anchors: state.schema.anchors.map((item) => item.id === anchorId ? { ...item, parts: [...item.parts, { kind: 'field', binding }] } : item) };
    const next = await options.updateSchema(schema, { captureNative: true });
    if (next) { setState(next); options.resumeFocus?.(anchorId, next.schema); }
    setSelection([]);
    return !!next;
  };
  const editFormula = async (anchorId: string) => {
    if (!state || options.readOnly) return;
    try {
      const result = await options.requestNative('formula', { anchorId, schema: state.schema });
      if (!result?.ok) throw new Error(result?.error || 'Редактор не открыл формулу.');
      setSelection([]);
    } catch (reason: any) { options.onError(String(reason?.message || reason)); }
  };
  const edited = async (payload: any) => {
    if (options.readOnly) return;
    setBusy(true);
    try {
      const current = payload?.schema?.version === 1 ? null : await options.requestState();
      const schema = payload?.schema?.version === 1 ? payload.schema : current?.schema && Array.isArray(payload?.parts) ? { ...current.schema, anchors: current.schema.anchors.map((anchor) => anchor.id === payload.anchorId ? { ...anchor, parts: payload.parts } : anchor) } : null;
      if (!schema) throw new Error('Редактор не вернул привязки формулы.');
      await options.updateSchema(schema);
    }
    catch (reason: any) { options.onError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  };
  const cancel = () => {
    const anchorId = selection[0]?.anchorId;
    setSelection([]);
    if (anchorId && state && options.isInlineEditing?.()) requestAnimationFrame(() => { void options.requestNative('formula', { anchorId, schema: state.schema }).catch((reason) => options.onError(String(reason?.message || reason))); });
  };
  return { open, edited, dialog: <FluxCellActionsDialog open={!!selection.length} selectedAnchors={selection} fields={fields} readOnly={options.readOnly} busy={busy}
    onCancel={cancel} onPreviewMerge={(request) => merge(request, false)} onConfirmMerge={(request) => merge(request, true)} onInsertField={insert} onEditFormula={editFormula} /> };
}
