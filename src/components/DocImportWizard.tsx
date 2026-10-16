import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, FileSpreadsheet, FileText, Upload, ClipboardPaste, Loader2, CheckCircle2,
  AlertTriangle, ChevronDown, ChevronRight, Trash2, ScanLine, Plus,
} from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import { extractByName, extractClipboard, looksLikeCadExport } from '../import/extractors';
import { draftToUnits, applyMatrixColumn } from '../import/recognize';
import { recognizeAsync, extractRecognizeAsync } from '../import/importClient';
import { loadLearnedDict, getLearnedDict, loadSymbolRules, observe } from '../import/learn';
import EquipmentImportPreview from './EquipmentImportPreview';
import { DraftItem, DraftField, DraftResult, Confidence } from '../import/types';
import CustomSelect from './CustomSelect';
import ImportFileChooser from './ImportFileChooser';
import EquipmentSourceImportDialog from './equipment/EquipmentSourceImportDialog';
import FileBadge from './ui/FileBadge';
import { ICON_SIZE } from '../lib/metrics';
import type { SelectionProvenance } from '../lib/windowsFiles';
import type { EquipmentDocumentBinding, FilenameMatchRule } from '../../equipment/documentBindings';
import { canonicalDocumentSourceFolder, equipmentDocumentImportSource, equipmentDocumentRevisionFolder, getLocalEquipmentDocumentRef, loadEquipmentDocumentBindings, saveLocalEquipmentDocumentRef } from '../lib/equipmentDocumentBindings';
import { base64ToBytes, takeWindowsDrop, windowsFilesRequest } from '../lib/windowsFiles';
import { WINDOWS_IMPORT_READ_BYTES, type ImportedFileRef } from '../../filesystem/contracts';
import { listEquipmentSourceBindings, removeEquipmentSourceBinding, scanEquipmentSource, type EquipmentSourceCandidate, type LocalEquipmentSourceBinding } from '../lib/equipmentSourcesLocal';

// Мастер импорта документов: PDF / Excel / Word / XML / вставка из буфера.
// Распознавание полностью на клиенте; на сервер уходит только подтверждённый результат.

interface DocImportWizardProps {
  projectId: string;
  categories: { id: string; label: string }[];
  onClose: () => void;
  onImported: () => void;
  canManage?: boolean;
  initialDocument?: { binding: EquipmentDocumentBinding; fileRef: import('../lib/windowsFiles').WindowsFileRef; sourceFolder: import('../lib/windowsFiles').WindowsFileRef; revision: string; sha256: string } | null;
  /** Отключает файловое перетаскивание в сценариях, где нужен только выбор файла. */
  allowDrop?: boolean;
}

interface FileJob {
  id: string;
  fileName: string;
  status: 'parsing' | 'ocr' | 'ready' | 'error' | 'imported';
  statusText?: string;
  provenance?: SelectionProvenance;
  sourceSha256?: string;
  sourceRevision?: string;
  sourceBinding?: EquipmentDocumentBinding;
  draft?: DraftResult;
  error?: string;
  /** Исходные данные PDF — нужны для запуска OCR по кнопке */
  pdfData?: ArrayBuffer;
  /** Исходные данные изображения (JPG/PNG/…) — OCR запускается сразу */
  imageData?: ArrayBuffer;
  scanPages?: number[];
  /** Диапазон страниц для OCR (напр. «1-5,8»); пусто = все сканы */
  pageRange?: string;
  /** Пиксельное улучшение скана (grayscale/контраст/бинаризация/deskew) */
  ocrEnhance?: boolean;
  /** Управление отменой текущего OCR */
  ocrController?: AbortController;
  /**
   * Разобранная выгрузка САПР: установки, моноблоки и блоки.
   *
   * Лежит отдельно от `draft`: распознавания здесь не было и обучать словарь
   * нечему — разбор точный, а не угаданный.
   */
  cad?: { units: any[]; blocks: number };
}

interface LegacyMigrationCandidate {
  binding: LocalEquipmentSourceBinding;
  candidate: EquipmentSourceCandidate;
  locator?: SelectionProvenance['portableLocator'];
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif'];

// «1-5, 8» ∩ допустимые страницы; пусто/мусор → все допустимые
function parsePageSelection(text: string | undefined, allowed: number[]): number[] {
  const t = (text || '').trim();
  if (!t) return allowed;
  const set = new Set<number>();
  for (const part of t.split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) set.add(n);
    } else if (/^\d+$/.test(part.trim())) {
      set.add(+part.trim());
    }
  }
  const picked = allowed.filter(p => set.has(p));
  return picked.length ? picked : allowed;
}

const CONF_STYLE: Record<Confidence, string> = {
  high: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300',
  mid: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300',
  low: 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400',
};

const CONF_LABEL: Record<Confidence, string> = { high: 'уверенно', mid: 'проверьте', low: 'не распознано' };

let jobSeq = 0;

async function documentSourceProvenance(provenance: SelectionProvenance): Promise<SelectionProvenance> {
  if (!provenance.sourceFolder || !provenance.fileRef) return provenance;
  const canonical = canonicalDocumentSourceFolder(provenance.sourceFolder, provenance.fileRef);
  if (canonical.sourceFolder.relativePath === provenance.sourceFolder.relativePath) return provenance;
  try {
    const resolved = await windowsFilesRequest<SelectionProvenance>({
      action: 'selectionProvenance', ref: canonical.sourceFolder, fileRef: provenance.fileRef,
    });
    if (resolved.ok) return { ...resolved.data, ...(provenance.suggestedTag ? { suggestedTag: provenance.suggestedTag } : {}) };
  } catch { /* Provenance is optional; file parsing must still work. */ }
  // Keep local matching possible if the shared locator cannot be derived.
  return { ...provenance, sourceFolder: canonical.sourceFolder, portableLocator: undefined, folderKey: undefined };
}

function revisionFromSource(file: File, provenance: SelectionProvenance): string {
  const sourcePath = provenance.sourceFolder?.relativePath.replace(/\\/gu, '/') || '';
  const filePath = provenance.fileRef?.relativePath.replace(/\\/gu, '/') || '';
  const rest = filePath.startsWith(sourcePath ? `${sourcePath}/` : '') ? filePath.slice(sourcePath ? sourcePath.length + 1 : 0).split('/').filter(Boolean) : [];
  const folderRevision = rest.length > 1 ? rest[0] : '';
  if (equipmentDocumentRevisionFolder(folderRevision)) return folderRevision;
  return file.lastModified ? new Date(file.lastModified).toISOString() : 'без ревизии';
}

function findExistingDocumentBinding(
  bindings: EquipmentDocumentBinding[], provenance: SelectionProvenance, fileName: string,
): EquipmentDocumentBinding | undefined {
  if (!provenance.sourceFolder) return undefined;
  const shared = provenance.portableLocator?.folderKey;
  if (shared) return bindings.find(item => item.kind === 'document' && item.fileName === fileName && item.locator?.folderKey === shared);
  return bindings.find(item => {
    if (item.kind !== 'document' || item.fileName !== fileName) return false;
    const local = getLocalEquipmentDocumentRef(item.projectId, item.id);
    return !!local && local.sourceFolder.rootId === provenance.sourceFolder?.rootId
      && local.sourceFolder.relativePath.replace(/\\/gu, '/') === provenance.sourceFolder?.relativePath.replace(/\\/gu, '/');
  });
}

export default function DocImportWizard({ projectId, categories, onClose, onImported, allowDrop = true, canManage = false, initialDocument = null }: DocImportWizardProps) {
  const { addToast } = useToastStore();
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [category, setCategory] = useState(categories[0]?.id || 'FAN');
  const [isDragOver, setIsDragOver] = useState(false);
  // Открытый предпросмотр: что именно ввозим и из какой работы
  // Открытый предпросмотр: один файл или несколько выбранных расчётов разом
  const [preview, setPreview] = useState<{ jobIds: string[]; units: any[]; fileName: string } | null>(null);
  const [sourceJobId, setSourceJobId] = useState<string | null>(null);
  // Выбранные расчёты: ввозятся одним предпросмотром и одной партией. Готовый
  // расчёт отмечается сам — ради этого папку файлов и бросают в окно разом
  const [collapsedItems, setCollapsedItems] = useState<Record<string, boolean>>({});
  const [bindingRevision, setBindingRevision] = useState(0);
  const [documentBindings, setDocumentBindings] = useState<EquipmentDocumentBinding[]>([]);
  const [bindingWarning, setBindingWarning] = useState('');
  const [legacyCandidates, setLegacyCandidates] = useState<LegacyMigrationCandidate[]>([]);
  const [migrationSelection, setMigrationSelection] = useState<Set<string>>(new Set());
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [bindingRefreshPending, setBindingRefreshPending] = useState(false);
  const [bindingRefreshFailed, setBindingRefreshFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadEquipmentDocumentBindings(projectId, controller.signal).then(view => {
      setBindingRevision(view.revision);
      setDocumentBindings(view.bindings);
      if (view.canManage) void (async () => {
        const legacy = listEquipmentSourceBindings(projectId).filter(binding => !view.bindings.some(item => item.kind === 'cad-xml' && (item.xmlSourceId || item.id) === binding.sourceId));
        const available: LegacyMigrationCandidate[] = [];
        for (const binding of legacy) {
          const scan = await scanEquipmentSource(binding).catch(() => null);
          if (!scan || scan.status !== 'ready' || !scan.recommended) continue;
          const candidate = scan.recommended;
          const provenance = await windowsFilesRequest<SelectionProvenance>({ action: 'selectionProvenance', ref: { rootId: binding.rootId, relativePath: binding.relativePath }, fileRef: candidate.fileRef });
          available.push({ binding, candidate, locator: provenance.ok === true ? provenance.data.portableLocator : undefined });
        }
        if (!controller.signal.aborted) {
          setLegacyCandidates(available);
          setMigrationSelection(new Set(available.map(item => item.binding.sourceId)));
        }
      })();
    }).catch(error => {
      if (!controller.signal.aborted) setBindingWarning(error instanceof Error ? error.message : 'Не удалось загрузить привязки источников.');
    });
    return () => controller.abort();
  }, [projectId]);

  const refreshBindingLedger = useCallback(async () => {
    setBindingRefreshPending(true); setBindingWarning('');
    try {
      const view = await loadEquipmentDocumentBindings(projectId);
      setBindingRevision(view.revision); setDocumentBindings(view.bindings); setBindingRefreshFailed(false);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось обновить общий список привязок.';
      setBindingWarning(message); setBindingRefreshFailed(true);
      addToast(`Импорт сохранён, но список общих источников не обновился: ${message}`, 'error');
      return false;
    } finally { setBindingRefreshPending(false); }
  }, [projectId, addToast]);

  const confirmLegacyMigration = async () => {
    const selected = legacyCandidates.filter(item => migrationSelection.has(item.binding.sourceId));
    if (!selected.length || migrationBusy) return;
    setMigrationBusy(true); setBindingWarning('');
    try {
      const response = await fetch(`/api/equipment/projects/${encodeURIComponent(projectId)}/document-bindings/migrate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: bindingRevision, confirmed: true, bindings: selected.map(item => ({
          sourceId: item.binding.sourceId, fileName: item.candidate.fileName,
          ...(item.locator ? { locator: item.locator } : {}), ...(item.binding.selectedRule ? { rule: item.binding.selectedRule } : {}),
        })) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Не удалось перенести локальные привязки. Старые записи сохранены.');
      const view = await loadEquipmentDocumentBindings(projectId);
      // Сначала сохраняем новые device-local capabilities; исходные записи удаляем только после подтверждения сервера.
      for (const item of selected) saveLocalEquipmentDocumentRef({ projectId, bindingId: item.binding.sourceId, sourceFolder: { rootId: item.binding.rootId, relativePath: item.binding.relativePath }, fileRef: item.candidate.fileRef });
      for (const item of selected) removeEquipmentSourceBinding(projectId, item.binding.sourceId, item.binding.tagId || '', item.binding.elementId);
      setBindingRevision(view.revision); setDocumentBindings(view.bindings); setMigrationOpen(false);
      setLegacyCandidates(current => current.filter(item => !migrationSelection.has(item.binding.sourceId)));
      addToast(`Перенесено общих привязок: ${selected.length}.`, 'success');
    } catch (error) { setBindingWarning(error instanceof Error ? error.message : 'Не удалось перенести привязки.'); }
    finally { setMigrationBusy(false); }
  };

  const updateJob = useCallback((id: string, patch: Partial<FileJob>) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  }, []);

  // ── Обработка файлов ────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File, provenance: SelectionProvenance = {}, forcedBinding?: EquipmentDocumentBinding) => {
    const id = `job-${++jobSeq}`;
    setJobs(prev => [...prev, { id, fileName: file.name, status: 'parsing', statusText: 'Чтение файла…', provenance }]);
    setActiveJobId(prev => prev || id);
    try {
      const normalizedProvenance = await documentSourceProvenance(provenance);
      updateJob(id, { provenance: normalizedProvenance });
      const data = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', data);
      const sourceSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const sourceRevision = revisionFromSource(file, normalizedProvenance);
      const sourceBinding = forcedBinding || findExistingDocumentBinding(documentBindings, normalizedProvenance, file.name);
      updateJob(id, { sourceSha256, sourceRevision, sourceBinding, provenance: normalizedProvenance });
      const ext = (file.name.split('.').pop() || '').toLowerCase();

      // Изображение (фото/скан формы): распознаётся по кнопке OCR ниже
      if (IMAGE_EXTS.includes(ext)) {
        updateJob(id, {
          status: 'ready',
          imageData: data,
          scanPages: [1],
          draft: { docType: 'unknown', items: [], warnings: [], stats: { dataBlocks: 0, totalBlocks: 0 } },
        });
        return;
      }

      /**
       * Выгрузка расчёта из САПР: её не распознают, её разбирают.
       *
       * Внутри не бланк, а плоский словарь из десятков тысяч узлов — каждое
       * отверстие и каждый винт. Распознавание бланка сделало бы из этого
       * мусор, поэтому файл уходит на разбор настоящим движком, и человек
       * попадает в тот же предпросмотр, что и при ввозе расчёта из Проводника.
       *
       * Раньше на этом месте стоял совет пойти в «Оборудование» → «Импорт
       * расчёта». Кнопки с таким именем там нет — и человек оставался ни с чем
       * (обращение ОБР-000006).
       */
      if (ext === 'xml') {
        const text = new TextDecoder('utf-8').decode(data);
        if (looksLikeCadExport(text)) {
          updateJob(id, { statusText: 'Разбор расчёта…' });
          const res = await fetch('/api/equipment/parse-calc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Проект — ради его кода: по нему в примечаниях ищутся теги
            body: JSON.stringify({ text, fileName: file.name, projectId }),
          });
          const parsed = await res.json().catch(() => ({}));
          if (!res.ok) {
            updateJob(id, { status: 'error', error: String(parsed?.error || 'Не удалось разобрать расчёт') });
            return;
          }
          const units = Array.isArray(parsed?.units) ? parsed.units : [];
          const blocks = units.reduce(
            (s: number, u: any) => s + (u.monoblocks || []).reduce((k: number, m: any) => k + (m.blocks || []).length, 0),
            0,
          );
          updateJob(id, { status: 'ready', statusText: undefined, cad: { units, blocks } });
          return;
        }
      }

      // «Чистые» форматы: извлечение и распознавание целиком в фоновом воркере.
      // Excel/CSV/XML структурированы → надёжный источник обучения: учимся сразу.
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'xml') {
        const draft = await extractRecognizeAsync(ext, data, getLearnedDict());
        observe(draft.observations);
        updateJob(id, { status: 'ready', draft });
        return;
      }

      // PDF/DOCX/прочее: извлечение на главном потоке (нужны браузерные библиотеки),
      // распознавание — в фоне
      const outcome = await extractByName(file.name, data, (done, total) =>
        updateJob(id, { statusText: `Чтение PDF: страница ${done} из ${total}…` }));
      const doc = outcome.doc;

      // PDF со сканами: показываем кнопку OCR
      if (outcome.pdf && outcome.pdf.scanPages.length > 0) {
        updateJob(id, { pdfData: data, scanPages: outcome.pdf.scanPages });
      }

      if (doc.blocks.length === 0 && outcome.pdf && outcome.pdf.scanPages.length > 0) {
        // Все страницы — сканы; ждём решения пользователя (кнопка «Распознать скан»)
        updateJob(id, {
          status: 'ready',
          draft: { docType: 'unknown', items: [], warnings: doc.warnings, stats: { dataBlocks: 0, totalBlocks: 0 } },
        });
        return;
      }

      updateJob(id, { statusText: 'Распознавание…' });
      const draft = await recognizeAsync(doc, getLearnedDict());
      // Word — надёжный источник; PDF-текст учим только при подтверждении импорта
      if (ext === 'docx') observe(draft.observations);
      updateJob(id, { status: 'ready', draft });
    } catch (err: any) {
      console.error('Ошибка разбора документа:', err);
      updateJob(id, { status: 'error', error: err?.message || 'Не удалось разобрать файл' });
    }
  }, [updateJob, projectId, documentBindings]);

  const initialDocumentLoaded = useRef('');
  useEffect(() => {
    if (!initialDocument || initialDocumentLoaded.current === initialDocument.binding.id) return;
    initialDocumentLoaded.current = initialDocument.binding.id;
    void windowsFilesRequest<{ name: string; size: number; modifiedAt: string; sha256: string; base64: string }>({ action: 'read', ref: initialDocument.fileRef }).then(result => {
      if (result.ok === false) throw new Error(result.error.message);
      const bytes = base64ToBytes(result.data.base64);
      const file = new File([bytes], initialDocument.binding.fileName, { lastModified: Date.parse(result.data.modifiedAt) || Date.now() });
      void processFile(file, { fileRef: initialDocument.fileRef, sourceFolder: initialDocument.sourceFolder, portableLocator: initialDocument.binding.locator }, initialDocument.binding);
    }).catch(error => setBindingWarning(error instanceof Error ? error.message : 'Не удалось открыть новую ревизию документа.'));
  }, [initialDocument, processFile]);

  const handleFiles = useCallback((files: FileList | File[], provenances: SelectionProvenance[] = []) => {
    Array.from(files).forEach((f, index) => { void processFile(f, provenances[index] || {}); });
  }, [processFile]);

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setIsDragOver(false);
    const dropped = takeWindowsDrop();
    if (!dropped?.ticket) { if (event.dataTransfer.files.length) handleFiles(event.dataTransfer.files); return; }
    let tickets: ImportedFileRef[] = [];
    try {
      const prepared = await windowsFilesRequest<{ files: ImportedFileRef[] }>({ action: 'prepareDroppedImportRefs', ticket: dropped.ticket });
      if (prepared.ok === false) throw new Error(prepared.error.message);
      tickets = prepared.data.files;
      const files: File[] = [];
      for (const ticket of tickets) {
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < ticket.size; offset += WINDOWS_IMPORT_READ_BYTES) {
          const part = await windowsFilesRequest<{ size: number; offset: number; base64: string }>({ action: 'readImportRef', ticket: ticket.ticket, offset, length: Math.min(WINDOWS_IMPORT_READ_BYTES, ticket.size - offset) });
          if (part.ok === false) throw new Error(part.error.message);
          if (part.data.offset !== offset || part.data.size !== ticket.size) throw new Error('Файл изменился во время чтения. Перетащите его повторно.');
          chunks.push(base64ToBytes(part.data.base64));
        }
        files.push(new File(chunks, ticket.name, { lastModified: ticket.lastModified }));
      }
      handleFiles(files, tickets.map(ticket => ticket.provenance || {}));
    } catch (error) {
      setBindingWarning(error instanceof Error ? error.message : 'Не удалось прочитать перетащенные файлы.');
    } finally {
      if (tickets.length) await windowsFilesRequest({ action: 'releaseImportRefs', tickets: tickets.map(ticket => ticket.ticket) });
    }
  }, [handleFiles]);

  // ── OCR сканов по кнопке ────────────────────────────────────────────────────

  const runOcr = useCallback(async (job: FileJob) => {
    const isImage = !!job.imageData;
    if (!isImage && (!job.pdfData || !job.scanPages?.length)) return;
    const controller = new AbortController();
    updateJob(job.id, { status: 'ocr', statusText: 'Подготовка OCR…', ocrController: controller });
    try {
      const { ocrPdfPages, ocrImage, ocrAvailable } = await import('../import/ocr');
      if (!(await ocrAvailable())) {
        updateJob(job.id, { status: 'ready', statusText: undefined, ocrController: undefined });
        addToast('OCR-модуль недоступен в этой сборке. Пересохраните документ с текстовым слоем или используйте Excel/Word.', 'error');
        return;
      }
      const enhance = job.ocrEnhance ?? false;
      const onProgress = (p: { status: string }) => updateJob(job.id, { statusText: p.status });
      const result = isImage
        ? await ocrImage(job.imageData!, { signal: controller.signal, enhance, onProgress })
        : await ocrPdfPages(job.pdfData!, parsePageSelection(job.pageRange, job.scanPages!), { signal: controller.signal, enhance, onProgress });
      const { blocks, failed, aborted, meanConfidence } = result;
      if (aborted) {
        updateJob(job.id, { status: 'ready', statusText: undefined, ocrController: undefined });
        addToast('Распознавание остановлено.', 'info');
        return;
      }
      if (!blocks.length) {
        updateJob(job.id, { status: 'ready', statusText: undefined, ocrController: undefined });
        addToast('Не удалось распознать текст. Попробуйте вариант лучшего качества (300 dpi) или включите «Улучшить скан».', 'error');
        return;
      }
      const warns: string[] = [];
      if (failed.length) warns.push(`Не распознаны: ${failed.join(', ')}.`);
      if (meanConfidence) {
        warns.push(meanConfidence < 60
          ? `Средняя уверенность OCR ${meanConfidence}% — проверьте значения особенно внимательно (жёлтые поля).`
          : `Средняя уверенность OCR ${meanConfidence}%.`);
      }
      const draft = await recognizeAsync({ blocks, source: 'pdf-ocr', warnings: warns }, getLearnedDict());
      updateJob(job.id, { status: 'ready', statusText: undefined, ocrController: undefined, draft });
    } catch (err: any) {
      console.error('OCR не удался:', err);
      updateJob(job.id, { status: 'ready', statusText: undefined, ocrController: undefined });
      addToast('OCR не удался: ' + (err?.message || 'неизвестная ошибка'), 'error');
    }
  }, [updateJob, addToast]);

  const cancelOcr = useCallback((job: FileJob) => {
    job.ocrController?.abort();
  }, []);

  // ── Вставка из буфера обмена ────────────────────────────────────────────────

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Файлы из буфера (скопированный файл)
      if (e.clipboardData?.files?.length) {
        handleFiles(e.clipboardData.files);
        e.preventDefault();
        return;
      }
      const html = e.clipboardData?.getData('text/html') || '';
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!html && !text.trim()) return;
      // Вставку в поля ввода не перехватываем
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const id = `job-${++jobSeq}`;
      setJobs(prev => [...prev, { id, fileName: 'Вставка из буфера', status: 'parsing' }]);
      setActiveJobId(prev => prev || id);
      const doc = extractClipboard(html, text);
      recognizeAsync(doc, getLearnedDict())
        .then(draft => { observe(draft.observations); setJobs(prev => prev.map(j => j.id === id ? { ...j, status: 'ready', draft } : j)); })
        .catch((err: any) => setJobs(prev => prev.map(j => j.id === id ? { ...j, status: 'error', error: err?.message } : j)));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles]);

  // Esc — закрыть
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // При закрытии мастера освобождаем тяжёлые воркеры OCR (языковые модели в памяти)
  useEffect(() => {
    return () => { import('../import/ocr').then(m => m.terminateOcrPool()).catch(() => {}); };
  }, []);

  // Загружаем общий выученный словарь синонимов (авто-обучение)
  useEffect(() => { loadLearnedDict().catch(() => {}); loadSymbolRules().catch(() => {}); }, []);

  // ── Правки черновика ────────────────────────────────────────────────────────

  const patchItem = (jobId: string, itemId: string, patch: Partial<DraftItem>) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId || !j.draft) return j;
      return { ...j, draft: { ...j.draft, items: j.draft.items.map(it => it.id === itemId ? { ...it, ...patch } : it) } };
    }));
  };

  const patchField = (jobId: string, itemId: string, fieldIdx: number, patch: Partial<DraftField>) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId || !j.draft) return j;
      return {
        ...j,
        draft: {
          ...j.draft,
          items: j.draft.items.map(it => it.id === itemId
            ? { ...it, fields: it.fields.map((f, i) => i === fieldIdx ? { ...f, ...patch, confidence: 'high' as Confidence } : f) }
            : it),
        },
      };
    }));
  };

  const removeField = (jobId: string, itemId: string, fieldIdx: number) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId || !j.draft) return j;
      return {
        ...j,
        draft: { ...j.draft, items: j.draft.items.map(it => it.id === itemId ? { ...it, fields: it.fields.filter((_, i) => i !== fieldIdx) } : it) },
      };
    }));
  };

  const removeItem = (jobId: string, itemId: string) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId || !j.draft) return j;
      return { ...j, draft: { ...j.draft, items: j.draft.items.filter(it => it.id !== itemId) } };
    }));
  };

  // Выбор колонки матричной таблицы: заново извлекаем значения выбранного
  // типоразмера из сохранённых строк матрицы и подставляем их в позицию.
  const chooseMatrixColumn = (jobId: string, itemId: string, header: string) => {
    setJobs(prev => prev.map(j => {
      if (j.id !== jobId || !j.draft) return j;
      return { ...j, draft: { ...j.draft, items: j.draft.items.map(it => it.id === itemId ? applyMatrixColumn(it, header) : it) } };
    }));
    addToast(`Типоразмер «${header}» выбран — значения подставлены, проверьте их.`, 'success');
  };

  // ── Импорт ──────────────────────────────────────────────────────────────────

  // Второй шаг — предпросмотр: тот же, что у ввоза расчёта из Проводника.
  // Раньше эта кнопка писала в базу сразу: без плана, без диффа со старыми
  // значениями, без выбора области и без разбора тегов. Теперь оба источника
  // сходятся в одном окне, поэтому и результат у них одинаковый.
  const commitJob = (job: FileJob) => {
    // CAD XML остаётся в общей очереди, но получает штатный план источника XML.
    if (job.cad) {
      setSourceJobId(job.id);
      return;
    }
    if (!job.draft || job.draft.items.length === 0) return;
    setPreview({
      jobIds: [job.id],
      units: draftToUnits(job.draft.items, job.fileName.replace(/\.[^.]+$/, '')),
      fileName: job.fileName,
    });
  };

  const previewDone = async (summary?: { bindingId?: string; bindingWarning?: string | null }) => {
    const done = jobs.filter(j => preview?.jobIds.includes(j.id));
    setPreview(null);
    if (!done.length) return;
    const bound = done[0];
    if (summary?.bindingId && bound.provenance?.sourceFolder) {
      saveLocalEquipmentDocumentRef({ projectId, bindingId: summary.bindingId, sourceFolder: bound.provenance.sourceFolder, fileRef: bound.provenance.fileRef });
    }
    if (summary?.bindingId) await refreshBindingLedger();
    for (const job of done) {
      // Подтверждённый импорт — надёжная разметка: учим словарь по всем источникам (в т.ч. PDF/OCR).
      // У разобранного расчёта учить нечему: там не распознавание, а точный разбор
      observe(job.draft?.observations);
      updateJob(job.id, { status: 'imported' });
    }
    const count = done.reduce((s, job) => s + (job.cad ? job.cad.blocks : (job.draft?.items.length || 0)), 0);
    addToast(done.length > 1
      ? `Файлов: ${done.length}, импортировано позиций: ${count}`
      : `«${done[0].fileName}»: импортировано позиций: ${count}`, 'success');
    if (summary?.bindingWarning) addToast(`Оборудование импортировано, но связь с документом не сохранена: ${summary.bindingWarning}`, 'error');
    onImported();
  };

  const activeJob = jobs.find(j => j.id === activeJobId) || jobs[0] || null;
  const readyCount = jobs.filter(j => j.status === 'ready' && ((j.draft?.items.length || 0) > 0 || (j.cad?.blocks || 0) > 0)).length;
  const previewJob = preview ? jobs.find(job => job.id === preview.jobIds[0]) : undefined;
  const documentSource = previewJob?.provenance?.sourceFolder && previewJob.sourceSha256
    ? equipmentDocumentImportSource({
      ...(previewJob.sourceBinding ? { id: previewJob.sourceBinding.id } : {}),
      expectedLedgerRevision: bindingRevision,
      ...(previewJob.provenance.portableLocator || previewJob.sourceBinding?.locator ? { locator: previewJob.provenance.portableLocator || previewJob.sourceBinding?.locator } : {}),
      fileName: previewJob.fileName,
      rule: { kind: 'document-name', fileName: previewJob.fileName },
      revision: previewJob.sourceRevision || 'без ревизии',
      sha256: previewJob.sourceSha256,
      ...(previewJob.sourceBinding?.systemId ? { systemId: previewJob.sourceBinding.systemId } : {}),
      ...(previewJob.sourceBinding?.tag ? { tag: previewJob.sourceBinding.tag } : {}),
    })
    : undefined;

  // ── Рендер ──────────────────────────────────────────────────────────────────

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 fx-backdrop" onClick={onClose}>
      <div
        className="fx-dialog w-full max-w-5xl h-[86vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        {...(allowDrop ? {
          onDragOver: (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragOver(true); },
          onDragLeave: () => setIsDragOver(false),
          onDrop: handleDrop,
        } : {})}
      >
        {/* Шапка */}
        <div className="flex flex-wrap items-center justify-between gap-y-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center">
              <ScanLine className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Импорт из документов</h2>
            </div>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
              <CustomSelect
                value={category}
                onChange={setCategory}
                options={categories.map(c => ({ value: c.id, label: c.label }))}
                placeholder="Категория оборудования"
              />
            </div>
            <button type="button" onClick={onClose} className="shrink-0 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 cursor-pointer" title="Закрыть (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {legacyCandidates.length > 0 && <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex flex-wrap items-center justify-between gap-2"><span>Найдены локальные XML-привязки, которые ещё не доступны коллегам.</span><button type="button" onClick={() => setMigrationOpen(value => !value)} className="rounded border border-amber-500 px-2 py-1 font-medium">{migrationOpen ? 'Скрыть перенос' : `Подготовить перенос · ${legacyCandidates.length}`}</button></div>
          {migrationOpen && <div className="mt-2 space-y-2 rounded border border-amber-300 p-2 dark:border-amber-800">
            <p>После подтверждения общие записи появятся у участников проекта. Локальные ссылки будут удалены только после ответа сервера; неподдерживаемые или недоступные источники останутся на устройстве.</p>
            <div className="max-h-28 space-y-1 overflow-auto">{legacyCandidates.map(item => <label key={item.binding.sourceId} className="flex items-start gap-2"><input type="checkbox" checked={migrationSelection.has(item.binding.sourceId)} onChange={() => setMigrationSelection(current => { const next = new Set(current); next.has(item.binding.sourceId) ? next.delete(item.binding.sourceId) : next.add(item.binding.sourceId); return next; })} /><span>{item.candidate.fileName} · ревизия {item.candidate.revision}{item.locator ? '' : ' · только это устройство'}</span></label>)}</div>
            <div className="flex gap-2"><button type="button" disabled={!migrationSelection.size || migrationBusy} onClick={() => void confirmLegacyMigration()} className="rounded bg-amber-700 px-2.5 py-1.5 font-medium text-white disabled:opacity-50">{migrationBusy ? 'Перенос…' : `Подтвердить перенос · ${migrationSelection.size}`}</button><button type="button" disabled={migrationBusy} onClick={() => setMigrationOpen(false)} className="rounded border border-amber-500 px-2.5 py-1.5">Отмена</button></div>
            {bindingWarning && <p role="alert" className="text-rose-700 dark:text-rose-300">{bindingWarning}</p>}
          </div>}
        </div>}
        {bindingRefreshFailed && <div role="alert" className="flex items-center gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><span className="flex-1">{bindingWarning || 'Импорт завершён, но список привязок нужно обновить перед следующим файлом.'}</span><button type="button" disabled={bindingRefreshPending} onClick={() => void refreshBindingLedger()} className="rounded border border-rose-400 px-2 py-1 font-medium disabled:opacity-50">{bindingRefreshPending ? 'Обновление…' : 'Обновить привязки'}</button></div>}

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          {/* Левая колонка: файлы */}
          <div className="w-full lg:w-64 lg:shrink-0 max-h-[38%] lg:max-h-none border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col min-h-0">
            <div
              className={`m-3 p-4 border-2 border-dashed rounded-xl text-center transition-colors ${
                isDragOver ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-slate-300 dark:border-slate-700'
                }`}
            >
              <Upload className="w-5 h-5 mx-auto text-slate-400 mb-1.5" />
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">{allowDrop ? 'Перетащите файлы или выберите источник' : 'Выберите файлы для импорта'}</p>
              <div className="mt-3 flex justify-center" onClick={event => event.stopPropagation()}>
                <ImportFileChooser disabled={bindingRefreshPending || bindingRefreshFailed} multiple accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,.gif" label="Выбрать файлы" onFiles={handleFiles} />
              </div>
            </div>
            <div className="px-3 pb-1 flex items-center gap-1.5 text-2xs text-slate-400">
              <ClipboardPaste className="w-3 h-3" /> Или Ctrl+V — таблица из Excel/Word
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {jobs.map(j => {
                // У разобранного расчёта позиции считаются по блокам: своих
                // «распознанных позиций» у него нет, и «нет данных» в списке
                // рядом с разобранным файлом — прямая неправда
                const itemCount = j.cad ? j.cad.blocks : (j.draft?.items.length || 0);
                return (
                  <div key={j.id} className="flex items-start gap-1.5">
                  <span className="w-[13px] shrink-0" />
                  <button type="button"
                    onClick={() => setActiveJobId(j.id)}
                    className={`flex-1 min-w-0 text-left p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                      activeJob?.id === j.id
                        ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30'
                        : 'border-slate-150 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <FileBadge file={j.fileName} size={ICON_SIZE.row} />
                      <span className="font-semibold text-slate-800 dark:text-slate-300 truncate">{j.fileName}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-2xs">
                      {(j.status === 'parsing' || j.status === 'ocr') && <><Loader2 className="w-3 h-3 animate-spin text-emerald-500" /> <span className="text-slate-400 truncate">{j.statusText || 'Разбор…'}</span></>}
                      {j.status === 'ready' && itemCount > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-medium">{itemCount} позиц.</span>}
                      {j.status === 'ready' && itemCount === 0 && <span className="text-amber-500 font-semibold">нет данных</span>}
                      {j.status === 'imported' && <span className="text-emerald-600 flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" /> импортировано</span>}
                      {j.status === 'error' && <span className="text-rose-500 truncate">{j.error}</span>}
                    </div>
                  </button>
                  </div>
                );
              })}
            </div>

            {jobs.length > 1 && (
              <div className="p-2 border-t border-slate-100 dark:border-slate-850 text-2xs text-slate-400 text-center">
                Файлов: {jobs.length} · готово к импорту: {readyCount}
              </div>
            )}
          </div>

          {/* Правая колонка: предпросмотр активного файла */}
          <div className="flex-1 min-w-0 flex flex-col">
            {!activeJob ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center">
                <ScanLine className="w-10 h-10 text-slate-200 dark:text-slate-800 mb-3" />
                <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">Добавьте документ — распознавание начнётся сразу</p>
              </div>
            ) : activeJob.status === 'parsing' || activeJob.status === 'ocr' ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2">
                <Loader2 className="w-7 h-7 animate-spin text-emerald-500" />
                <p className="text-xs">{activeJob.statusText || 'Разбор документа…'}</p>
                {activeJob.status === 'ocr' && activeJob.ocrController && (
                  <button type="button"
                    onClick={() => cancelOcr(activeJob)}
                    className="mt-1 px-3 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-900 cursor-pointer"
                  >
                    Остановить распознавание
                  </button>
                )}
              </div>
            ) : activeJob.status === 'error' ? (
              <div className="flex-1 flex flex-col items-center justify-center text-rose-500 gap-2 p-6 text-center">
                <AlertTriangle className="w-8 h-8" />
                <p className="text-sm font-semibold">{activeJob.error}</p>
              </div>
            ) : (
              <>
                {/* Предупреждения и OCR-предложение */}
                <div className="px-4 pt-3 space-y-1.5 shrink-0">
                  {(activeJob.scanPages?.length || 0) > 0 && activeJob.status !== 'imported' && (
                    <div className="p-2.5 rounded-lg bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900 text-xs space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sky-800 dark:text-sky-300 flex items-center gap-1.5">
                          <ScanLine className="w-3.5 h-3.5" />
                          {activeJob.imageData ? 'Изображение — готово к распознаванию' : `Страниц-сканов без текста: ${activeJob.scanPages!.length}`}
                        </span>
                        <button type="button"
                          onClick={() => runOcr(activeJob)}
                          className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-semibold cursor-pointer shrink-0"
                        >
                          Распознать (OCR)
                        </button>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        {!activeJob.imageData && activeJob.scanPages!.length > 1 && (
                          <label className="flex items-center gap-1.5 text-sky-700 dark:text-sky-300">
                            Страницы:
                            <input
                              value={activeJob.pageRange || ''}
                              onChange={e => updateJob(activeJob.id, { pageRange: e.target.value })}
                              placeholder={`все (${activeJob.scanPages![0]}–${activeJob.scanPages![activeJob.scanPages!.length - 1]})`}
                              className="w-32 px-1.5 py-0.5 rounded border border-sky-300 dark:border-sky-800 bg-white dark:bg-slate-950 outline-none font-mono text-slate-800 dark:text-slate-100"
                            />
                          </label>
                        )}
                        <label className="flex items-center gap-1.5 text-sky-700 dark:text-sky-300 cursor-pointer" title="Grayscale, контраст, бинаризация, выравнивание перекоса. Помогает на бледных/кривых сканах, но может навредить чистым — включайте при плохом результате.">
                          <input
                            type="checkbox"
                            checked={activeJob.ocrEnhance || false}
                            onChange={e => updateJob(activeJob.id, { ocrEnhance: e.target.checked })}
                            className="accent-sky-600"
                          />
                          Улучшить скан (бета)
                        </label>
                      </div>
                    </div>
                  )}
                  {activeJob.draft?.warnings.map((w, i) => (
                    <div key={i} className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {w}
                    </div>
                  ))}
                </div>

                {/* Позиции */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {/* Выгрузка САПР: разобрана точно, распознавать нечего */}
                  {activeJob.cad && (
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 p-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <h3 className="text-sm font-semibold text-slate-800 dark:text-white">Расчёт разобран</h3>
                      </div>
                      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                        Это выгрузка из расчётной программы. Здесь ничего не угадывалось:
                        установки, моноблоки и блоки взяты из файла как есть.
                      </p>
                      <ul className="mt-2 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                        {activeJob.cad.units.map((u: any, i: number) => (
                          <li key={i} className="truncate">
                            <span className="font-semibold">{u.name}</span>
                            {u.title && u.title !== u.name ? ` — ${u.title}` : ''}
                            <span className="text-slate-400 dark:text-slate-500">
                              {' '}· моноблоков: {(u.monoblocks || []).length}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">
                        Дальше — тот же предпросмотр, что и при ввозе расчёта из Проводника:
                        видно, что изменится, и можно снять лишнее.
                      </p>
                    </div>
                  )}

                  {(activeJob.draft?.items || []).map(item => {
                    const collapsed = collapsedItems[item.id];
                    return (
                      <div key={item.id} className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                        {/* Шапка позиции */}
                        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-900/60">
                          <button type="button"
                            onClick={() => setCollapsedItems(p => ({ ...p, [item.id]: !p[item.id] }))}
                            className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                          >
                            {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                          </button>
                          <input
                            value={item.title}
                            onChange={e => patchItem(activeJob.id, item.id, { title: e.target.value })}
                            className="flex-1 bg-transparent text-xs font-medium text-slate-900 dark:text-white outline-none border-b border-transparent focus:border-emerald-400"
                            title="Название позиции (можно исправить)"
                          />
                          {item.brand && (
                            <span className="text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300">{item.brand}</span>
                          )}
                          {item.system && (
                            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">{item.system}</span>
                          )}
                          <button type="button"
                            onClick={() => removeItem(activeJob.id, item.id)}
                            className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-400 hover:text-rose-500 cursor-pointer"
                            title="Не импортировать эту позицию"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Выбор колонки матрицы */}
                        {item.matrixHeaders && item.matrixHeaders.length > 0 && (
                          <div className="px-3 py-2 border-t border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 text-xs">
                            <span className="font-semibold text-amber-800 dark:text-amber-300">В таблице несколько типоразмеров — какой ваш?</span>
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {item.matrixHeaders.map(h => (
                                <button type="button"
                                  key={h}
                                  onClick={() => chooseMatrixColumn(activeJob.id, item.id, h)}
                                  className="fx-btn fx-btn-sm"
                                >
                                  {h}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Поля */}
                        {!collapsed && (
                          <div className="divide-y divide-slate-100 dark:divide-slate-900">
                            {item.fields.map((f, fi) => (
                              <div key={fi} className={`flex items-center gap-2 px-3 py-1.5 text-xs border-l-2 ${CONF_STYLE[f.confidence]}`}>
                                <span className="w-44 shrink-0 truncate font-semibold" title={f.label}>{f.label}</span>
                                <input
                                  value={f.value}
                                  onChange={e => patchField(activeJob.id, item.id, fi, { value: e.target.value })}
                                  className="flex-1 min-w-0 px-1.5 py-0.5 bg-white/70 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded outline-none focus:border-emerald-400 text-slate-800 dark:text-slate-100 font-mono"
                                />
                                <input
                                  value={f.unit || ''}
                                  onChange={e => patchField(activeJob.id, item.id, fi, { unit: e.target.value })}
                                  placeholder="ед."
                                  className="w-14 shrink-0 px-1.5 py-0.5 bg-white/70 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded outline-none focus:border-emerald-400 text-slate-500 dark:text-slate-400"
                                />
                                <span className="w-20 shrink-0 text-2xs opacity-70 text-right">{CONF_LABEL[f.confidence]}</span>
                                <button type="button"
                                  onClick={() => removeField(activeJob.id, item.id, fi)}
                                  className="p-0.5 rounded hover:bg-rose-100 dark:hover:bg-rose-950/50 text-slate-300 hover:text-rose-500 cursor-pointer shrink-0"
                                  title="Убрать параметр"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                            <button type="button"
                              onClick={() => patchItem(activeJob.id, item.id, {
                                fields: [...item.fields, { label: 'Параметр', value: '', unit: '', group: 'Прочее', confidence: 'high', source: 'table' }],
                              })}
                              className="w-full px-3 py-1.5 text-xs text-slate-400 hover:text-emerald-600 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 flex items-center gap-1 cursor-pointer"
                            >
                              <Plus className="w-3 h-3" /> Добавить параметр вручную
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {activeJob.draft && activeJob.draft.items.length === 0 && (activeJob.scanPages?.length || 0) === 0 && (
                    <div className="text-center py-10 text-slate-400 text-xs">
                      <AlertTriangle className="w-6 h-6 mx-auto mb-2 opacity-60" />
                      Параметры оборудования в документе не найдены.
                    </div>
                  )}
                </div>

                {/* Нижняя панель импорта: разобранный расчёт */}
                {activeJob.status === 'ready' && activeJob.cad && (
                  <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
                    <div className="text-xs text-slate-400">
                      Установок: {activeJob.cad.units.length} · блоков: {activeJob.cad.blocks}
                    </div>
                    <button type="button"
                      onClick={() => commitJob(activeJob)} disabled={!canManage || bindingRefreshPending || bindingRefreshFailed}
                      className="fx-btn fx-btn-primary shrink-0"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Проверить и импортировать в «{categories.find(c => c.id === category)?.label || category}»
                    </button>
                  </div>
                )}

                {/* Нижняя панель импорта */}
                {activeJob.status === 'ready' && !activeJob.cad && (activeJob.draft?.items.length || 0) > 0 && (
                  <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 shrink-0">
                    <div className="min-w-0 text-xs text-slate-400">
                      Зелёное — уверенно · жёлтое — проверьте · серое — подпись не распознана.
                    </div>
                    <button type="button"
                      onClick={() => commitJob(activeJob)} disabled={!canManage || bindingRefreshPending || bindingRefreshFailed}
                      className="fx-btn fx-btn-primary w-full min-w-0 h-auto min-h-[var(--flux-control-h)] py-2 lg:w-auto lg:py-0 whitespace-normal text-left lg:text-center leading-5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Проверить и импортировать {activeJob.draft!.items.length} позиц. в «{categories.find(c => c.id === category)?.label || category}»
                    </button>
                  </div>
                )}
                {activeJob.status === 'imported' && (
                  <div className="px-4 py-3 border-t border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 shrink-0">
                    <CheckCircle2 className="w-4 h-4" /> Импортировано. Позиции появились в разделе «Оборудование».
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Второй шаг: тот же предпросмотр, что у ввоза расчёта из Проводника */}
      {preview && (
        <EquipmentImportPreview
          draft={{ units: preview.units, fileName: preview.fileName, ...(documentSource ? { sourceBinding: documentSource } : {}) }}
          category={category}
          categoryLabel={categories.find(c => c.id === category)?.label || category}
          projectId={projectId}
          onClose={() => setPreview(null)}
          onDone={previewDone}
          embedded
        />
      )}
      {sourceJobId && (() => {
        const job = jobs.find(item => item.id === sourceJobId);
        if (!job) return null;
        const initialSelection = job.provenance?.fileRef ? {
          ref: job.provenance.fileRef, name: job.fileName, sourceFolder: job.provenance.sourceFolder,
          suggestedTag: job.provenance.suggestedTag, portableLocator: job.provenance.portableLocator,
        } : undefined;
        return <div className="absolute inset-3 z-10 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-950">
          <EquipmentSourceImportDialog embedded projectId={projectId} categories={categories} canManage={canManage}
            initialSelection={initialSelection} expectedLedgerRevision={bindingRevision}
            onClose={() => setSourceJobId(null)}
            onImported={async ({ bindingId, source, category: importedCategory }) => {
              if (bindingId && job.provenance?.sourceFolder) saveLocalEquipmentDocumentRef({ projectId, bindingId, sourceFolder: job.provenance.sourceFolder, fileRef: job.provenance.fileRef });
              if (bindingId) await refreshBindingLedger();
              updateJob(job.id, { status: 'imported' }); setSourceJobId(null); setCategory(importedCategory);
              addToast(`«${job.fileName}»: XML импортирован, привязка сохранена.`, 'success'); onImported();
            }} />
        </div>;
      })()}
    </div>,
    document.body
  );
}
