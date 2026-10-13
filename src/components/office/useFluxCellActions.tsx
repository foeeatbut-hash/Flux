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
  // Сохранённые привязки не хранят displayName, а окно формулы подписывает метку им,
  // иначе вместо «DrivePower» в ячейку попадает ключ «param:@DrivePower».
  const labeled = (schema: OfficeHeaderSchema, known: OfficeField[] = fields): OfficeHeaderSchema => {
    const fill = (binding: OfficeBinding): OfficeBinding => {
      if ((binding as any).displayName) return binding;
      const field = known.find((item) => item.sourceId === binding.sourceId && item.fieldKey === binding.fieldKey);
      return field ? { ...binding, displayName: field.displayName } as OfficeBinding : binding;
    };
    return { ...schema, anchors: schema.anchors.map((anchor) => ({ ...anchor, parts: anchor.parts.map((part: any) => part.kind === 'field' ? { ...part, binding: fill(part.binding) }
      : part.kind === 'union' ? { ...part, alternatives: part.alternatives.map(fill) } : part) })) };
  };
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
      requestAnimationFrame(() => { void options.requestNative('formula', { anchorId, schema: labeled(state.schema) }).catch((reason) => options.onError(String(reason?.message || reason))); });
      return true;
    }
    const schema: OfficeHeaderSchema = { ...state.schema, anchors: state.schema.anchors.map((item) => item.id === anchorId ? { ...item, parts: [...item.parts, { kind: 'field', binding }] } : item) };
    const next = await options.updateSchema(schema, { captureNative: true });
    if (next) { setState(next); options.resumeFocus?.(anchorId, labeled(next.schema)); }
    setSelection([]);
    return !!next;
  };
  // Ввод прямо в ячейке шапки: редактор сообщает о начале правки привязанной ячейки,
  // и окно формулы открывается поверх неё без промежуточного диалога.
  const beginEdit = async (payload: any) => {
    const anchorId = String(payload?.anchorId || '');
    if (options.readOnly || !anchorId) return;
    try {
      const current = await options.requestState();
      if (!current) throw new Error('Схема документа недоступна.');
      if (!current.schema.anchors.some((anchor) => anchor.id === anchorId)) throw new Error('Сначала привяжите параметр к ячейке шапки.');
      const known = fieldsFromCatalog(await officeDataApi.catalog(options.projectId));
      setState(current); setFields(known);
      const result = await options.requestNative('formula', { anchorId, schema: labeled(current.schema, known), initialText: typeof payload?.initialText === 'string' ? payload.initialText : '' });
      if (!result?.ok) throw new Error(result?.error || 'Редактор не открыл ячейку.');
    } catch (reason: any) { options.onError(String(reason?.message || reason)); }
  };
  // Текст, набранный в ячейке Word между метками, живёт в документе; в схему он попадает
  // при записи файла: сверяем схему с тем, что прочитано из ячеек, и пишем, если разошлись.
  const syncing = useRef(false);
  const syncAgain = useRef(false);
  const syncFromNative = async () => {
    if (options.readOnly || options.isInlineEditing?.()) return;
    // Набор продолжился, пока схема сверялась: после сверки повторяем, чтобы не потерять хвост
    if (syncing.current) { syncAgain.current = true; return; }
    syncing.current = true;
    try {
      const live = await options.requestState();
      const stored = await officeDataApi.state(options.fileId);
      if (!live || !stored.schema.anchors.length) return;
      // Только формулы (ячейка начинается с «=»): обычную подпись рядом с меткой схема не хранит,
      // и перезапись таких ячеек сбивала бы выделение. Сравниваем состав частей, а не служебные поля.
      const shape = (parts: OfficeHeaderSchema['anchors'][number]['parts']) => parts.map((part: any) => part.kind === 'field' ? `f:${part.binding.sourceId}:${part.binding.fieldKey}` : part.kind === 'union' ? `u:${part.alternatives.map((item: any) => item.fieldKey).join(',')}` : part.kind === 'operator' ? `o:${part.operator}` : `t:${part.text}`).join('|');
      const changed = new Map<string, OfficeHeaderSchema['anchors'][number]['parts']>();
      for (const anchor of live.schema.anchors) {
        const first: any = anchor.parts[0];
        const before = stored.schema.anchors.find((item) => item.id === anchor.id);
        if (before && first?.kind === 'text' && first.text.trimStart().startsWith('=') && shape(anchor.parts) !== shape(before.parts)) changed.set(anchor.id, anchor.parts);
      }
      if (!changed.size) return;
      await options.updateSchema({ ...stored.schema, anchors: stored.schema.anchors.map((anchor) => changed.has(anchor.id) ? { ...anchor, parts: changed.get(anchor.id)! } : anchor) }, { storeOnly: true });
    } catch (reason: any) { options.onError(String(reason?.message || reason)); }
    finally { syncing.current = false; }
    if (syncAgain.current) { syncAgain.current = false; await syncFromNative(); }
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
    if (anchorId && state && options.isInlineEditing?.()) requestAnimationFrame(() => { void options.requestNative('formula', { anchorId, schema: labeled(state.schema) }).catch((reason) => options.onError(String(reason?.message || reason))); });
  };
  return { open, beginEdit, syncFromNative, edited, dialog: <FluxCellActionsDialog open={!!selection.length} selectedAnchors={selection} fields={fields} readOnly={options.readOnly} busy={busy}
    onCancel={cancel} onPreviewMerge={(request) => merge(request, false)} onConfirmMerge={(request) => merge(request, true)} onInsertField={insert} /> };
}
