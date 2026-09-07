import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, FileSpreadsheet, FileText, Upload, ClipboardPaste, Loader2, CheckCircle2,
  AlertTriangle, ChevronDown, ChevronRight, Trash2, ScanLine, Plus,
} from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import { extractByName, extractClipboard } from '../import/extractors';
import { draftToUnits, applyMatrixColumn } from '../import/recognize';
import { recognizeAsync, extractRecognizeAsync } from '../import/importClient';
import { loadLearnedDict, getLearnedDict, loadSymbolRules, observe } from '../import/learn';
import EquipmentImportPreview from './EquipmentImportPreview';
import { DraftItem, DraftField, DraftResult, Confidence } from '../import/types';
import CustomSelect from './CustomSelect';

// Мастер импорта документов: PDF / Excel / Word / XML / вставка из буфера.
// Распознавание полностью на клиенте; на сервер уходит только подтверждённый результат.

interface DocImportWizardProps {
  projectId: string;
  categories: { id: string; label: string }[];
  onClose: () => void;
  onImported: () => void;
}

interface FileJob {
  id: string;
  fileName: string;
  status: 'parsing' | 'ocr' | 'ready' | 'error' | 'imported';
  statusText?: string;
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

export default function DocImportWizard({ projectId, categories, onClose, onImported }: DocImportWizardProps) {
  const { addToast } = useToastStore();
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [category, setCategory] = useState(categories[0]?.id || 'FAN');
  const [isDragOver, setIsDragOver] = useState(false);
  // Открытый предпросмотр: что именно ввозим и из какой работы
  const [preview, setPreview] = useState<{ jobId: string; units: any[]; fileName: string } | null>(null);
  const [collapsedItems, setCollapsedItems] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateJob = useCallback((id: string, patch: Partial<FileJob>) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  }, []);

  // ── Обработка файлов ────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    const id = `job-${++jobSeq}`;
    setJobs(prev => [...prev, { id, fileName: file.name, status: 'parsing', statusText: 'Чтение файла…' }]);
    setActiveJobId(prev => prev || id);
    try {
      const data = await file.arrayBuffer();
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
  }, [updateJob]);

  const handleFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach(f => { processFile(f); });
  }, [processFile]);

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
    if (!job.draft || job.draft.items.length === 0) return;
    setPreview({
      jobId: job.id,
      units: draftToUnits(job.draft.items, job.fileName.replace(/\.[^.]+$/, '')),
      fileName: job.fileName,
    });
  };

  const previewDone = () => {
    const job = jobs.find(j => j.id === preview?.jobId);
    setPreview(null);
    if (!job) return;
    // Подтверждённый импорт — надёжная разметка: учим словарь по всем источникам (в т.ч. PDF/OCR)
    observe(job.draft?.observations);
    updateJob(job.id, { status: 'imported' });
    addToast(`«${job.fileName}»: импортировано позиций: ${job.draft?.items.length || 0}`, 'success');
    onImported();
  };

  const activeJob = jobs.find(j => j.id === activeJobId) || jobs[0] || null;
  const readyCount = jobs.filter(j => j.status === 'ready' && (j.draft?.items.length || 0) > 0).length;

  // ── Рендер ──────────────────────────────────────────────────────────────────

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-5xl h-[86vh] bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={e => { e.preventDefault(); setIsDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
      >
        {/* Шапка */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center">
              <ScanLine className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Импорт из документов</h2>
              <p className="text-xs text-slate-400">PDF · Excel · Word · XML · вставка таблицы (Ctrl+V)</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-56">
              <CustomSelect
                value={category}
                onChange={setCategory}
                options={categories.map(c => ({ value: c.id, label: c.label }))}
                placeholder="Категория оборудования"
              />
            </div>
            <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 cursor-pointer" title="Закрыть (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* Левая колонка: файлы */}
          <div className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col">
            <div
              className={`m-3 p-4 border-2 border-dashed rounded-xl text-center cursor-pointer transition-colors ${
                isDragOver ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-slate-300 dark:border-slate-700 hover:border-emerald-400'
              }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-5 h-5 mx-auto text-slate-400 mb-1.5" />
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">Перетащите файлы или кликните</p>
              <p className="text-2xs text-slate-400 mt-1">.pdf .xlsx .docx .xml .csv · фото/скан .jpg .png</p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,.gif"
                className="hidden"
                onChange={e => { if (e.target.files?.length) { handleFiles(e.target.files); e.target.value = ''; } }}
              />
            </div>
            <div className="px-3 pb-1 flex items-center gap-1.5 text-2xs text-slate-400">
              <ClipboardPaste className="w-3 h-3" /> Или Ctrl+V — таблица из Excel/Word
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {jobs.map(j => {
                const itemCount = j.draft?.items.length || 0;
                return (
                  <button type="button"
                    key={j.id}
                    onClick={() => setActiveJobId(j.id)}
                    className={`w-full text-left p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                      activeJob?.id === j.id
                        ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30'
                        : 'border-slate-150 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {j.fileName.toLowerCase().endsWith('.pdf') ? <FileText className="w-3.5 h-3.5 text-rose-500 shrink-0" /> : <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                      <span className="font-semibold text-slate-800 dark:text-slate-300 truncate">{j.fileName}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-2xs">
                      {(j.status === 'parsing' || j.status === 'ocr') && <><Loader2 className="w-3 h-3 animate-spin text-emerald-500" /> <span className="text-slate-400 truncate">{j.statusText || 'Разбор…'}</span></>}
                      {j.status === 'ready' && itemCount > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-bold">{itemCount} позиц.</span>}
                      {j.status === 'ready' && itemCount === 0 && <span className="text-amber-500 font-semibold">нет данных</span>}
                      {j.status === 'imported' && <span className="text-emerald-600 flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" /> импортировано</span>}
                      {j.status === 'error' && <span className="text-rose-500 truncate">{j.error}</span>}
                    </div>
                  </button>
                );
              })}
              {jobs.length === 0 && (
                <p className="text-xs text-slate-400 text-center px-4 py-6">
                  Бланки подбора, ведомости, опросные листы, страницы каталогов — с любым расположением данных.
                </p>
              )}
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
                <p className="text-xs mt-1 max-w-sm">Программа сама найдёт наименование, марку и характеристики. Перед импортом всё можно проверить и поправить.</p>
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
                            className="flex-1 bg-transparent text-xs font-bold text-slate-900 dark:text-white outline-none border-b border-transparent focus:border-emerald-400"
                            title="Название позиции (можно исправить)"
                          />
                          {item.brand && (
                            <span className="text-2xs font-mono font-bold px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300">{item.brand}</span>
                          )}
                          {item.system && (
                            <span className="text-2xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">{item.system}</span>
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
                                  className="px-2 py-1 rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-950 font-mono font-bold text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/50 cursor-pointer"
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
                                <span className="w-20 shrink-0 text-2xs uppercase tracking-wider opacity-70 text-right">{CONF_LABEL[f.confidence]}</span>
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

                {/* Нижняя панель импорта */}
                {activeJob.status === 'ready' && (activeJob.draft?.items.length || 0) > 0 && (
                  <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
                    <div className="text-xs text-slate-400">
                      Зелёное — уверенно · жёлтое — проверьте · серое — подпись не распознана.
                    </div>
                    <button type="button"
                      onClick={() => commitJob(activeJob)}
                      className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
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
          draft={{ units: preview.units, fileName: preview.fileName }}
          category={category}
          categoryLabel={categories.find(c => c.id === category)?.label || category}
          projectId={projectId}
          onClose={() => setPreview(null)}
          onDone={previewDone}
        />
      )}
    </div>,
    document.body
  );
}
