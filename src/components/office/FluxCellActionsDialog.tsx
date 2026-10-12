import React, { useEffect, useMemo, useState } from 'react';
import { Btn, Dialog, Select } from '../ui';
import type { OfficeBinding, OfficePart } from '../../lib/officeModel';
import type { OfficeField } from './fluxData';

export interface FluxCellActionAnchor {
  anchorId: string;
  kind: 'word-row' | 'excel-range';
  documentPart?: string;
  sheetName?: string;
  address?: string;
  label?: string;
  displayText?: string;
  parts: OfficePart[];
  manualConflict?: string;
}

export interface FluxCellMergeRequest {
  targetAnchorId: string;
  sourceAnchorIds: string[];
  alternatives: OfficeCellAlternative[];
  outputLabel: string;
}

export type OfficeCellAlternative = OfficeBinding & { priority: number };

export interface FluxCellMergeResponse {
  ok: boolean;
  previewToken?: string;
  conflicts?: Array<{ rowIndex: number; targetText: string; sourceText: string }>;
  error?: string;
}

export interface FluxCellMergeConfirmation extends FluxCellMergeRequest {
  previewToken: string;
}

interface Props {
  open: boolean;
  selectedAnchors: FluxCellActionAnchor[];
  fields: OfficeField[];
  readOnly: boolean;
  busy?: boolean;
  onCancel: () => void;
  onPreviewMerge: (request: FluxCellMergeRequest) => Promise<FluxCellMergeResponse>;
  onConfirmMerge: (request: FluxCellMergeConfirmation) => Promise<FluxCellMergeResponse>;
  onInsertField?: (field: OfficeField, targetAnchorId: string) => Promise<boolean | void>;
  onEditFormula?: (anchorId: string) => void;
  onComplete?: (response: FluxCellMergeResponse) => void;
}

/** Позволяет подготовить объединение, а изменение документа оставляет нативному редактору. */
export default function FluxCellActionsDialog({ open, selectedAnchors, fields, readOnly, busy = false, onCancel, onPreviewMerge, onConfirmMerge, onInsertField, onEditFormula, onComplete }: Props) {
  const selectionKey = selectedAnchors.map((anchor) => `${anchor.anchorId}:${JSON.stringify(anchor.parts)}:${anchor.manualConflict || ''}`).join('|');
  const target = selectedAnchors[0];
  const source = selectedAnchors[1];
  const targetLabel = target ? anchorLabel(target, 0) : '';
  const mergePlan = useMemo(() => collectOfficeCellMergeAlternatives(selectedAnchors), [selectionKey]);
  const [preview, setPreview] = useState<FluxCellMergeResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [outputLabel, setOutputLabel] = useState(targetLabel);

  useEffect(() => {
    if (open) {
      setPreview(null);
      setError('');
      setFieldKey('');
      setOutputLabel(targetLabel);
    }
  }, [open, selectionKey]);

  const mutationsAllowed = open && !readOnly && !busy && !working;
  const canPreview = mutationsAllowed && selectedAnchors.length === 2 && !!target && !!source && mergePlan.alternatives.length > 1 && !mergePlan.error && !!outputLabel.trim();
  const conflictCount = preview?.conflicts?.length || 0;

  const runPreview = async () => {
    if (!canPreview || !target || !source) return;
    const request: FluxCellMergeRequest = {
      targetAnchorId: target.anchorId,
      sourceAnchorIds: [source.anchorId],
      alternatives: mergePlan.alternatives,
      outputLabel: outputLabel.trim(),
    };
    setWorking(true);
    setError('');
    try {
      const response = await onPreviewMerge(request);
      if (!response.ok) throw new Error(response.error || 'Редактор не подготовил предварительный просмотр.');
      if (!response.previewToken) throw new Error('Редактор не вернул токен предварительного просмотра. Повторите проверку.');
      setPreview(response);
    } catch (reason: unknown) {
      setError(errorText(reason));
      setPreview(null);
    } finally {
      setWorking(false);
    }
  };

  const confirmMerge = async () => {
    if (!preview?.previewToken || conflictCount || !canPreview || !target || !source) return;
    const request: FluxCellMergeConfirmation = {
      targetAnchorId: target.anchorId,
      sourceAnchorIds: [source.anchorId],
      alternatives: mergePlan.alternatives,
      outputLabel: outputLabel.trim(),
      previewToken: preview.previewToken,
    };
    setWorking(true);
    setError('');
    try {
      const response = await onConfirmMerge(request);
      if (!response.ok) throw new Error(response.error || 'Редактор не подтвердил объединение.');
      onComplete?.(response);
    } catch (reason: unknown) {
      setError(errorText(reason));
      setPreview(null);
    } finally {
      setWorking(false);
    }
  };

  const insertField = async () => {
    const field = fields.find((item) => fieldIdentity(item) === fieldKey);
    if (!field || !target || !onInsertField || !mutationsAllowed) return;
    setWorking(true);
    setError('');
    try {
      const result = await onInsertField(field, target.anchorId);
      if (result === false) throw new Error('Редактор не вставил параметр в выбранный заголовок.');
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setWorking(false);
    }
  };

  if (!open) return null;
  const blockedAnchor = selectedAnchors.find((anchor) => anchor.manualConflict);
  const supportedSelection = selectedAnchors.length === 1 || selectedAnchors.length === 2;

  return <Dialog title="Действия с заголовками" label="Действия с заголовочными ячейками" width="max-w-2xl" scrollBody busy={working || busy} onClose={onCancel}
    footer={<>
      <Btn disabled={working || busy} onClick={onCancel}>Закрыть</Btn>
      {selectedAnchors.length === 2 && <Btn tone="primary" disabled={preview ? !canPreview || conflictCount > 0 : !canPreview} onClick={() => void (preview ? confirmMerge() : runPreview())}>
        {working ? (preview ? 'Подтверждаем…' : 'Проверяем…') : (preview ? 'Подтвердить объединение' : 'Проверить объединение')}
      </Btn>}
    </>}>
    <div className="space-y-4">
      <p className="text-xs text-slate-600 dark:text-slate-300">Параметры в защищённых метках можно соединять формулой прямо в ячейке. Формула начинается со знака =; текст и операторы вводятся между метками в нативном редакторе.</p>

      {!supportedSelection && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">Для действий Flux выберите одну или две заголовочные ячейки.</p>}
      <section aria-label="Выбранные заголовочные ячейки" className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-700 dark:border-slate-700">
        {selectedAnchors.slice(0, 2).map((anchor, index) => <div key={anchor.anchorId} className="py-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-medium text-slate-800 dark:text-dark-text-main">{selectedAnchors.length === 2 ? (index === 0 ? 'Выходная ячейка · ' : 'Вторая ячейка · ') : 'Активная ячейка · '}{anchorLabel(anchor, index)}</span>
            {selectedAnchors.length === 2 && <span className="shrink-0 text-slate-500 dark:text-slate-400">Приоритет {index + 1}</span>}
          </div>
          {anchor.displayText && <p className="mt-1 truncate text-xs text-slate-600 dark:text-slate-300">{anchor.displayText}</p>}
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {bindingsIn(anchor.parts).map((binding, bindingIndex) => <span key={`${binding.sourceId}:${binding.entityType}:${binding.fieldKey}:${bindingIndex}`}>{fieldLabel(binding, fields)}</span>)}
            {!bindingsIn(anchor.parts).length && <span>Связанный параметр не найден</span>}
          </div>
          {anchor.manualConflict && <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{anchor.manualConflict}</p>}
        </div>)}
      </section>

      {selectedAnchors.length === 1 && <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!mutationsAllowed || !target || !onEditFormula} onClick={() => target && onEditFormula?.(target.anchorId)}>Редактировать формулу в ячейке</Btn>
        <span className="text-xs text-slate-500 dark:text-slate-400">Закроем окно и передадим фокус нативной ячейке.</span>
      </div>}

      {selectedAnchors.length === 2 && <section className="space-y-2" aria-label="Варианты параметра для выходной ячейки">
        <h4 className="text-xs font-semibold text-slate-800 dark:text-dark-text-main">Одна выходная колонка</h4>
        {mergePlan.alternatives.length > 0 ? <ol className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
          {mergePlan.alternatives.map((binding, index) => <li key={`${binding.sourceId}:${binding.entityType}:${binding.fieldKey}`}>{index + 1}. {fieldLabel(binding, fields)}</li>)}
        </ol> : <p className="text-xs text-slate-500 dark:text-slate-400">Сначала привяжите по одному параметру к каждой ячейке.</p>}
        <label className="block space-y-1 text-xs text-slate-600 dark:text-slate-300">
          <span>Имя выходного заголовка</span>
          <input value={outputLabel} onChange={(event) => { setOutputLabel(event.target.value); setPreview(null); }} disabled={!mutationsAllowed} className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 focus:border-emerald-600 focus:outline-none dark:border-dark-border dark:bg-dark-bg dark:text-dark-text-main" maxLength={120} />
        </label>
        {mergePlan.error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{mergePlan.error}</p>}
      </section>}

      {blockedAnchor && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">Действие остановлено: {anchorLabel(blockedAnchor, 0)} содержит конфликтующие ручные данные. Сначала разрешите конфликт в документе.</p>}
      {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}

      {preview && <section className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700" aria-label="Предварительный просмотр объединения">
        <h4 className="text-xs font-semibold text-slate-800 dark:text-dark-text-main">Предварительный просмотр</h4>
        <p className="text-xs text-slate-600 dark:text-slate-300">Останется «{targetLabel}» с заголовком «{outputLabel.trim()}». Вторая выбранная ячейка будет удалена только после подтверждения.</p>
        {conflictCount > 0 ? <div role="alert" className="space-y-1 text-xs text-rose-700 dark:text-rose-300">
          <p>В строках, где обе колонки содержат ручные значения, объединение заблокировано: {conflictCount} конфликтов.</p>
          {preview.conflicts?.slice(0, 8).map((conflict, index) => <p key={`${conflict.rowIndex}:${index}`}>Строка {conflict.rowIndex}: «{conflict.targetText}» / «{conflict.sourceText}»</p>)}
        </div> : <p role="status" className="text-xs text-slate-600 dark:text-slate-300">Конфликтов ручных значений не найдено. Можно подтвердить объединение.</p>}
      </section>}

      {onInsertField && selectedAnchors.length > 0 && <section className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700" aria-label="Вставка параметра в нативную формулу">
        <h4 className="text-xs font-semibold text-slate-800 dark:text-dark-text-main">Вставить параметр в формулу</h4>
        <div className="flex items-center gap-2"><Select aria-label="Параметр из каталога" value={fieldKey} onChange={(value) => setFieldKey(value)} options={[{ value: '', label: 'Выберите параметр' }, ...fields.map((field) => ({ value: fieldIdentity(field), label: `${field.displayName} · ${field.sourceId}` }))]} className="min-w-0 flex-1" />
          <Btn disabled={!fieldKey || !target || !mutationsAllowed} onClick={() => void insertField()}>Вставить метку</Btn></div>
        <p className="text-xs text-slate-500 dark:text-slate-400">В ячейке введите формулу со знака =, вставьте защищённые метки и добавьте между ними текст, операторы или скобки. Окно не меняет формулу.</p>
      </section>}
      {readOnly && <p className="text-xs text-amber-700 dark:text-amber-300">Документ открыт только для просмотра.</p>}
    </div>
  </Dialog>;
}

/** Сохраняем исходный порядок, потому что он задаёт приоритет первой найденной величины. */
export function collectOfficeCellMergeAlternatives(anchors: FluxCellActionAnchor[]): { alternatives: OfficeCellAlternative[]; error?: string } {
  if (anchors.length !== 2 || anchors[0].anchorId === anchors[1].anchorId) return { alternatives: [], error: 'Выберите ровно две разные заголовочные ячейки.' };
  if (anchors.some((anchor) => anchor.manualConflict)) return { alternatives: [], error: 'В выбранных ячейках есть конфликтующие ручные данные.' };

  const unique = new Map<string, OfficeBinding>();
  for (const anchor of anchors) {
    if (anchor.parts.some((part) => part.kind === 'operator') || hasFormulaPrefix(anchor.parts)) {
      return { alternatives: [], error: 'Сначала завершите формулу в нативной ячейке; формулу нельзя преобразовать в список вариантов.' };
    }
    const parts = anchor.parts.filter((part) => part.kind === 'field' || part.kind === 'union');
    if (parts.length !== 1) return { alternatives: [], error: 'Каждая ячейка должна содержать одну привязку или одну группу вариантов.' };
    const bindings = bindingsIn(parts);
    if (!bindings.length) return { alternatives: [], error: 'В одной из ячеек не найдены связанные параметры.' };
    for (const binding of bindings) {
      const key = `${binding.sourceId}\u0000${binding.entityType}\u0000${binding.fieldKey}`;
      if (!unique.has(key)) unique.set(key, { ...binding, anchorId: anchors[0].anchorId });
    }
  }

  const alternatives = [...unique.values()];
  const prioritized = alternatives.map((binding, priority) => ({ ...binding, priority }));
  if (prioritized.length < 2) return { alternatives: [], error: 'В обеих ячейках указан один параметр; для вариантов нужны разные параметры.' };
  return { alternatives: prioritized };
}

function hasFormulaPrefix(parts: OfficePart[]): boolean {
  const prefix: string[] = [];
  for (const part of parts) {
    if (part.kind !== 'text') break;
    prefix.push(part.text);
  }
  // Начальный знак равенства меняет смысл ячейки на выражение, даже если редактор хранит его обычным текстом.
  return prefix.join('').trimStart().startsWith('=');
}

function bindingsIn(parts: OfficePart[]): OfficeBinding[] {
  return parts.flatMap((part) => part.kind === 'field' ? [part.binding]
    : part.kind === 'union' ? [...part.alternatives].sort((left, right) => left.priority - right.priority) : []);
}

function anchorLabel(anchor: FluxCellActionAnchor, index: number): string {
  return anchor.label || `${anchor.sheetName ? `${anchor.sheetName}!` : ''}${anchor.address || `Ячейка шапки ${index + 1}`}`;
}

function fieldLabel(binding: OfficeBinding, fields: OfficeField[]): string {
  const field = fields.find((item) => item.sourceId === binding.sourceId && item.fieldKey === binding.fieldKey && item.entityType === binding.entityType);
  return field ? `${field.displayName} · ${field.sourceId}` : `${binding.fieldKey} · ${binding.sourceId}`;
}

function fieldIdentity(field: OfficeField): string {
  return `${field.sourceId}\u0000${field.entityType}\u0000${field.fieldKey}`;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
