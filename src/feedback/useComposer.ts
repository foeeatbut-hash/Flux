/**
 * Состояние формы обращения.
 *
 * Вынесено из компонента намеренно: здесь три вещи, каждая из которых при
 * ошибке молча теряет написанное, — сохранение черновика, проверка полей и
 * сборка пакета к отправке. В разметке им тесно, и проверить их там нечем.
 *
 * Главное правило формы: она НИЧЕГО не отправляет сама. Пока человек не нажал
 * «Отправить», написанное живёт только на его компьютере — это обещание из
 * согласия, и нарушить его формой проще всего.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LIMITS, newRequestId, refusedByName, validateSubmit,
  type Frequency, type Impact, type ReportType, type SubmitFeedbackV1,
} from '../../feedback/contracts';
import { draftKey, saveDraft, type Draft, type DraftAttachment } from './draftDb';
import { submissionQueue, type Package } from './submissionQueue';
import { getMeta, type Meta } from './feedbackApi';
import { rendererBundle } from '../lib/diagnostics';

export interface Fields {
  type: ReportType;
  title: string;
  description: string;
  steps: string[];
  expected: string;
  actual: string;
  benefit: string;
  frequency: Frequency;
  impact: Impact;
  incidentAt: string;
  sectionKey: string;
  projectId: string;
  technicalEvents: boolean;
  appContext: boolean;
}

export const emptyFields = (sectionKey = '', type: ReportType = 'BUG'): Fields => ({
  type, title: '', description: '', steps: [''], expected: '', actual: '', benefit: '',
  frequency: 'UNKNOWN', impact: 'NORMAL', incidentAt: new Date().toISOString(),
  sectionKey, projectId: '', technicalEvents: false, appContext: true,
});

/** Что показываем под формой про сохранение на этом устройстве. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'quota' | 'unavailable' | 'tooMany';

const SAVE_NOTE: Record<SaveState, string> = {
  idle: '',
  saving: 'Сохраняем…',
  saved: 'Сохранено на этом устройстве',
  quota: 'Не хватило места в браузере — выгрузите черновик файлом',
  unavailable: 'Черновик не сохраняется: браузер не даёт хранилище',
  tooMany: 'Слишком много незаконченных черновиков — разберите старые',
};

export const saveNote = (state: SaveState): string => SAVE_NOTE[state] || '';

/**
 * Собрать тело отправки.
 *
 * Проверяется тем же `validateSubmit`, которым проверяет сервер: если окно
 * разрешит отправить то, что сервер отвергнет, человек увидит отказ после
 * долгой загрузки вложений и без объяснения, что именно поправить.
 */
export function buildBody(
  fields: Fields, deploymentId: string, appVersion: string, clientRequestId: string,
): { ok: boolean; body?: Omit<SubmitFeedbackV1, 'uploadIds'>; error?: string } {
  const raw = {
    schemaVersion: 1,
    clientRequestId, deploymentId,
    type: fields.type,
    title: fields.title,
    description: fields.description,
    sectionKey: fields.sectionKey,
    ...(fields.projectId ? { projectId: fields.projectId } : {}),
    incidentAt: fields.incidentAt,
    appVersion,
    reproduction: fields.steps.filter((s) => s.trim()),
    expected: fields.expected,
    actual: fields.actual,
    benefit: fields.benefit,
    frequency: fields.frequency,
    impact: fields.impact,
    uploadIds: [],
    consent: {
      technicalEvents: fields.technicalEvents,
      appContext: fields.appContext,
      reviewedAt: new Date().toISOString(),
    },
  };
  const checked = validateSubmit(raw);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { uploadIds: _drop, ...body } = checked.value!;
  return { ok: true, body };
}

/** Почему файл не берём. Пустая строка — берём. */
export function refuseFile(file: { name: string; size: number; type: string }, total: number): string {
  if (refusedByName(file.name)) return 'Такие файлы не принимаем: их открывают, и открывать их опасно';
  const image = file.type.startsWith('image/');
  const max = image ? LIMITS.imageBytes : LIMITS.fileBytes;
  if (file.size > max) return `Файл больше ${Math.round(max / 1024 / 1024)} МБ`;
  if (total + file.size > LIMITS.attachmentsBytes) {
    return `Вместе вложения не должны превышать ${Math.round(LIMITS.attachmentsBytes / 1024 / 1024)} МБ`;
  }
  return '';
}

export interface Composer {
  fields: Fields;
  setFields: (next: Fields | ((prev: Fields) => Fields)) => void;
  attachments: DraftAttachment[];
  addFile: (file: File) => string;
  addBlob: (blob: Blob, name: string, kind: DraftAttachment['kind']) => string;
  dropFile: (id: string) => void;
  meta: Meta | null;
  metaError: string;
  save: SaveState;
  error: string;
  /** Готово к отправке: поля прошли ту же проверку, что и на сервере. */
  ready: boolean;
  draft: Draft | null;
  send: (overrides?: Partial<Fields>) => Promise<string>;
}

/**
 * Форма одного обращения.
 *
 * `draftId` задаётся снаружи и не меняется: продолжение начатого черновика —
 * это тот же самый черновик, а не новый рядом.
 */
export function useComposer(
  draftId: string, userId: string, appVersion: string, sectionKey = '', type: ReportType = 'BUG',
): Composer {
  const [fields, setFields] = useState<Fields>(() => emptyFields(sectionKey, type));
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState('');
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const timer = useRef<any>(null);

  useEffect(() => {
    let alive = true;
    getMeta().then((m) => { if (alive) setMeta(m); })
      .catch((e: any) => { if (alive) setMetaError(e?.message || 'Сервер не отвечает'); });
    return () => { alive = false; };
  }, []);

  const deploymentId = meta?.deploymentId || '';
  const key = deploymentId && userId ? draftKey(deploymentId, userId, draftId) : '';

  const draft = useMemo<Draft | null>(() => (key ? {
    id: key, deploymentId, userId, draftId, updatedAt: Date.now(),
    state: 'EDITING', fields: fields as unknown as Record<string, unknown>, attachments,
  } : null), [key, deploymentId, userId, draftId, fields, attachments]);

  // Черновик пишется с задержкой: запись на каждую букву кладёт по мегабайту
  // вложений в хранилище пятьдесят раз в минуту
  useEffect(() => {
    if (!draft) return;
    if (!fields.title && !fields.description && !attachments.length) return;
    setSave('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void saveDraft(draft).then((result) => {
        setSave(result.ok ? 'saved' : (result as any).reason);
      });
    }, 800);
    return () => clearTimeout(timer.current);
  }, [draft, fields.title, fields.description, attachments.length]);

  const total = attachments.reduce((sum, a) => sum + (a.blob?.size || 0), 0);

  const addBlob = useCallback((blob: Blob, name: string, kind: DraftAttachment['kind']): string => {
    if (attachments.length >= LIMITS.attachments) return `Вложений не больше ${LIMITS.attachments}`;
    const refused = refuseFile({ name, size: blob.size, type: blob.type }, total);
    if (refused) return refused;
    setAttachments((list) => [...list, { id: newRequestId(), name, kind, blob }]);
    return '';
  }, [attachments.length, total]);

  const addFile = useCallback((file: File): string =>
    addBlob(file, file.name, file.type.startsWith('image/') ? 'IMAGE' : 'FILE'), [addBlob]);

  const dropFile = useCallback((id: string) => {
    setAttachments((list) => list.filter((a) => a.id !== id));
  }, []);

  const built = deploymentId
    ? buildBody(fields, deploymentId, appVersion, '00000000-0000-4000-8000-000000000000')
    : { ok: false, error: 'Сервер ещё не ответил' };

  /**
   * Нажатие «Отправить».
   *
   * С этого мгновения пакет неизменен: ключ запроса выдаётся один раз и
   * записывается вместе с черновиком. Второе нажатие с тем же ключом вернёт ту
   * же карточку, а не заведёт вторую.
   */
  const send = useCallback(async (overrides?: Partial<Fields>): Promise<string> => {
    if (!draft || !deploymentId) return 'Сервер ещё не ответил — попробуйте ещё раз';
    const clientRequestId = newRequestId();
    // Правки, поданные прямо в вызов, важнее записанных: короткая форма
    // собирает заголовок из написанного в момент нажатия, и ждать следующей
    // отрисовки, чтобы отправить набранное, нельзя
    const going = overrides ? { ...fields, ...overrides } : fields;
    const ready = buildBody(going, deploymentId, appVersion, clientRequestId);
    if (!ready.ok) { setError(ready.error || 'Проверьте поля'); return ready.error || 'Проверьте поля'; }

    /**
     * Пакет диагностики берётся ЗДЕСЬ, а не при отметке галочки.
     *
     * Между отметкой и нажатием человек обычно ещё раз повторяет то, что
     * сломалось, — и именно эти события нужны разбирающему. Пакет снимается
     * один раз и виден в предпросмотре: молча его никто не собирает.
     */
    const files = attachments.slice();
    if (going.technicalEvents) {
      const bundle = rendererBundle(LIMITS.bundleBytes);
      files.push({ id: newRequestId(), name: 'диагностика.jsonl', kind: 'DIAGNOSTICS', blob: bundle });
    }

    const fixed: Draft = {
      ...draft, clientRequestId, state: 'QUEUED', attachments: files,
      fields: going as unknown as Record<string, unknown>,
    };
    const written = await saveDraft(fixed);
    // Хранилища может не быть — отправку это не отменяет, но пережить
    // перезапуск такая отправка уже не сможет, и молчать об этом нельзя
    if (!written.ok) setSave((written as any).reason);

    const pack: Package = {
      key: fixed.id, draftId, deploymentId, userId,
      body: ready.body!,
      files: files.map((a) => ({ id: a.id, name: a.name, kind: a.kind, blob: a.blob })),
    };
    await submissionQueue.enqueue(pack);
    setError('');
    return '';
  }, [draft, deploymentId, fields, appVersion, attachments, draftId, userId]);

  return {
    fields, setFields, attachments, addFile, addBlob, dropFile,
    meta, metaError, save, error, ready: built.ok, draft, send,
  };
}
