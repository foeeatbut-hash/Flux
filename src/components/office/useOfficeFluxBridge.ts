import { useCallback, useRef, useState } from 'react';
import type { OfficeBinding, OfficeHeaderSchema } from '../../lib/officeModel';
import type { FluxCellActionAnchor } from './FluxCellActionsDialog';
import type { FluxOfficeAnchorSelection } from './FluxOfficePanel';
import type { OfficeAnchorRow, OfficeFillPlan, OfficeState, OfficeTemplateLink } from './fluxData';
import { schemaFromNativeHeaders, type HeaderSchemaSyncOptions } from './officeNativeSchema';

/**
 * Мост панели Flux с редактором — общий для Word и Таблицы, для файлов
 * проекта и для файлов Проводника. Хост даёт два набора простых действий:
 * как говорить с редактором и как читать/писать файл; порядок «записать
 * правки → прочитать состояние → сверить хеш → записать схему» здесь один.
 */

/** Разговор с окном редактора: у Word это события окна, у Таблицы — каналы ipc. */
export interface OfficeEditorLink {
  readHeaders(schema: OfficeHeaderSchema): Promise<any>;
  /** captureNative: считать заголовки из редактора, иначе передать ему схему. */
  syncHeaders(schema: OfficeHeaderSchema, options: HeaderSchemaSyncOptions): Promise<any>;
  insertField(anchor: FluxOfficeAnchorSelection, binding: OfficeBinding, displayText: string): Promise<{ ok: boolean; anchorId?: string; inlineEditing?: boolean; error?: string } | null>;
  applyPlan(payload: { writes: OfficeFillPlan['writes']; schema: OfficeHeaderSchema; rows: OfficeAnchorRow[]; sourceRevision: string }): Promise<{ ok: boolean; rows?: OfficeAnchorRow[]; appliedCount?: number; manualRows?: string[]; error?: string } | null>;
  /** Объединение колонок и формула заголовка (окно действий над ячейкой). */
  native(operation: 'merge' | 'formula', payload: unknown): Promise<any>;
}

/** Файл, с которым работает хост: на сервере или локальный; записи и хеши — его дело. */
export interface OfficeFileLink {
  /** Состояние файла, как он сейчас записан. */
  state(): Promise<OfficeState>;
  /** Записывает схему и строки; возвращает хеш получившейся версии файла. */
  updateState(body: { baseHash: string; sourceRevision: string; schema: OfficeHeaderSchema; rows?: OfficeAnchorRow[]; template?: OfficeTemplateLink }): Promise<{ baseHash: string }>;
  /** Записывает правки редактора в файл; false — не записано. */
  flush(): Promise<boolean>;
  /** Записывает правки и читает состояние записанной версии, сверив хеш; ошибки со словами хоста. */
  committed(kind: 'plan' | 'schema'): Promise<{ current: OfficeState; savedHash: string }>;
  /** Хеш для следующего сохранения редактора — тот, что вернула запись схемы. */
  remember(hash: string): void;
  /** Редактор ещё открывается или уничтожается: ему вопросов не задаём. */
  notReady?(): boolean;
  /** Причина, по которой писать нельзя (например, общий файл без права держателя); '' — можно. */
  writeBlocked?(kind: 'plan' | 'schema'): string;
  messages: { notSaved: string; rowsMissing: string };
}

export const docsEditorLink = (ask: <T>(event: string, answer: string, ms: number, payload?: unknown) => Promise<T | null>): OfficeEditorLink => ({
  readHeaders: (schema) => ask<any>('getFluxHeaderSchema', 'flux:header-schema-read', 15_000, { schema }),
  syncHeaders: (schema, options) => ask<any>(options.captureNative ? 'getFluxHeaderSchema' : 'syncFluxHeaderSchema', options.captureNative ? 'flux:header-schema-read' : 'flux:header-schema-synced', 15_000, { schema, ...options }),
  insertField: (anchor, binding, displayText) => ask<any>('insertFluxField', 'flux:field-inserted', 8_500, { fieldKey: binding.fieldKey, displayText, anchorId: anchor.anchorId, binding }),
  applyPlan: (payload) => ask<any>('applyFluxPlan', 'flux:office-plan-applied', 30_000, payload),
  native: (operation, payload) => ask<any>(operation === 'merge' ? 'mergeFluxHeaderColumns' : 'editFluxHeaderFormula', operation === 'merge' ? 'flux:header-columns-merged' : 'flux:header-formula-edit-started', 30_000, payload),
});

export const sheetsEditorLink = (call: (channel: string, payload: unknown, responseChannel: string, timeout?: number) => Promise<any>): OfficeEditorLink => ({
  readHeaders: (schema) => call('flux:get-header-schema', { schema }, 'flux:header-schema-read'),
  syncHeaders: (schema, options) => call(options.captureNative ? 'flux:get-header-schema' : 'flux:sync-header-schema', { schema, ...options }, options.captureNative ? 'flux:header-schema-read' : 'flux:header-schema-synced'),
  insertField: (anchor, binding, displayText) => call('flux:insert-field', { name: `FLUX_ANCHOR_${anchor.anchorId.replace(/[^A-Za-z0-9_]/g, '_')}`, value: displayText, anchorId: anchor.anchorId, binding }, 'flux:field-inserted'),
  applyPlan: (payload) => call('flux:apply-office-plan', payload, 'flux:office-plan-applied', 30_000),
  native: (operation, payload) => call(operation === 'merge' ? 'flux:merge-header-columns' : 'flux:edit-header-formula', payload, operation === 'merge' ? 'flux:header-columns-merged' : 'flux:header-formula-edit-started', 30_000),
});

/**
 * identity — то, что меняет файл под панелью: при смене requestState получает
 * новое лицо, и панель перечитывает состояние.
 */
export function useOfficeFluxBridge(editor: OfficeEditorLink, file: OfficeFileLink, identity: string) {
  const [activeAnchor, setActiveAnchor] = useState<FluxOfficeAnchorSelection | null>(null);
  const inlineEditingRef = useRef(false);
  // Действия живут между отрисовками хоста, а ссылки на редактор и файл — свежие
  const live = useRef({ editor, file }); live.current = { editor, file };

  const requestState = useCallback(async (): Promise<OfficeState> => {
    const { editor: ed, file: fl } = live.current;
    // Во время повторного открытия правки ещё невозможны: читаем записанную
    // схему, а не посылаем запрос уничтожаемому или ещё не готовому фрейму.
    if (fl.notReady?.()) return fl.state();
    if (!(await fl.flush())) throw new Error(fl.messages.notSaved);
    const current = await fl.state();
    if (fl.notReady?.() || !current.schema.anchors.length) return current;
    const native = await ed.readHeaders(current.schema);
    return { ...current, schema: schemaFromNativeHeaders(current.schema, native) };
  }, [identity]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Состояние файла как записано, без записи правок редактора: лента спрашивает его, пока панель закрыта. */
  const peekState = useCallback(() => live.current.file.state(), []);

  const insertBinding = useCallback(async (anchor: FluxOfficeAnchorSelection | FluxCellActionAnchor, binding: OfficeBinding, displayText: string) => {
    const response = await live.current.editor.insertField(anchor as FluxOfficeAnchorSelection, binding, displayText);
    if (!response?.ok) throw new Error(response?.error || 'Редактор не вставил поле.');
    inlineEditingRef.current = response.inlineEditing === true;
    if (response.anchorId) setActiveAnchor({ ...(anchor as FluxOfficeAnchorSelection), anchorId: response.anchorId });
    return true;
  }, []);

  const applyWrites = useCallback(async (plan: OfficeFillPlan, schema: OfficeHeaderSchema, rows: OfficeAnchorRow[]) => {
    const { editor: ed, file: fl } = live.current;
    const blocked = fl.writeBlocked?.('plan');
    if (blocked) throw new Error(blocked);
    const response = await ed.applyPlan({ writes: plan.writes, schema, rows, sourceRevision: plan.sourceRevision });
    if (!response?.ok) throw new Error(response?.error || 'Редактор не применил план.');
    if (!Array.isArray(response.rows)) throw new Error(fl.messages.rowsMissing);
    const { current, savedHash } = await fl.committed('plan');
    const stored = await fl.updateState({ baseHash: savedHash, sourceRevision: plan.sourceRevision, schema, rows: response.rows });
    // Записана только часть Flux: окно остаётся открытым (иначе пропадает
    // история «назад»), а следующее сохранение сверяется уже с новым хешем
    fl.remember(stored.baseHash);
    return { appliedCount: Number(response.appliedCount ?? plan.writes.length), manualRows: Array.isArray(response.manualRows) ? response.manualRows.map(String) : [], state: { ...current, baseHash: stored.baseHash, sourceRevision: plan.sourceRevision, schema, rows: response.rows } };
  }, []);

  const updateSchema = useCallback(async (schema: OfficeHeaderSchema, options: HeaderSchemaSyncOptions = {}) => {
    const { editor: ed, file: fl } = live.current;
    const blocked = fl.writeBlocked?.('schema');
    if (blocked) throw new Error(blocked);
    // Связь с шаблоном касается только файла: редактор о ней не знает
    const { template, ...editorOptions } = options;
    const response = await ed.syncHeaders(schema, editorOptions);
    const syncedSchema = schemaFromNativeHeaders(schema, response);
    const { current, savedHash } = await fl.committed('schema');
    const stored = await fl.updateState({ baseHash: savedHash, sourceRevision: current.sourceRevision, schema: syncedSchema, ...(options.rows ? { rows: options.rows } : current.rows ? { rows: current.rows } : {}), ...(template !== undefined ? { template } : {}) });
    // Без переоткрытия: редактор уже содержит записанное, а история «назад» живёт в окне
    fl.remember(stored.baseHash);
    return await fl.state();
  }, []);

  return { activeAnchor, setActiveAnchor, inlineEditingRef, requestState, peekState, insertBinding, applyWrites, updateSchema };
}
