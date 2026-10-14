import React, { useMemo, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Area, Btn, FilterSeg, Field, Input, Select } from '../ui';
import { useToastStore } from '../../store/toastStore';
import { useTranslateStore } from '../../store/translateStore';
import { joinSegments } from '../../translate/engine';
import { ORIGIN_LABEL, type Segment } from '../../translate/types';
import {
  TRANSLATION_MODES, allowedScopes, scopeLabel, toRuntimePlacement,
  type TranslationLangDirection, type TranslationMode, type TranslationOrder, type TranslationScope, type TranslationSeparator,
} from '../../translate/placement';
import {
  useTranslationBridge, type OfficeTranslationApplyPayload, type OfficeTranslationPreviewItem, type OfficeTranslationUnit,
} from './TranslationBridgeContext';
import { TranslationRow, type ReviewedUnit } from './OfficeTranslationRow';

/** Режимы, где оригинал и перевод стоят рядом и нужны разделитель и порядок. */
const NEEDS_SEPARATOR: TranslationMode[] = ['inline-before', 'inline-after', 'after-paragraph'];
const SEPARATORS: Array<{ value: TranslationSeparator; label: string }> = [
  { value: 'newline', label: 'Новая строка' }, { value: 'slash', label: '/' }, { value: 'dash', label: '—' },
  { value: 'pipe', label: '|' }, { value: 'custom', label: 'Свой разделитель' },
];
const TARGET_LABEL: Record<OfficeTranslationPreviewItem['target'], string> = {
  same: 'в том же месте', 'new-block': 'новый абзац', 'new-cell': 'новая ячейка', 'new-sheet': 'новый лист', 'new-file': 'новый файл',
};
type Filter = 'all' | 'review' | 'stale';

const isStale = (unit: OfficeTranslationUnit) => unit.status === 'stale' || unit.status === 'detached' || unit.stale === true;
/** Что переводить сразу: новое и устаревшее; уже актуальное и переведённое в другом режиме по умолчанию пропускается. */
const skippedByDefault = (unit: OfficeTranslationUnit) => unit.status === 'current' || unit.status === 'replaced';

/** Перевод документа: те же локальные движок и память, что в обычном переводчике; запись — через мост окна. */
export default function OfficeTranslationPanel() {
  const bridge = useTranslationBridge()!;
  const many = useTranslateStore((s) => s.many);
  const remember = useTranslateStore((s) => s.remember);
  const addToast = useToastStore((s) => s.addToast);
  const [scope, setScope] = useState<TranslationScope>('document');
  const [mode, setMode] = useState<TranslationMode>(bridge.app === 'sheets' ? 'new-sheet' : 'after-paragraph');
  const [direction, setDirection] = useState<TranslationLangDirection>('ru-en');
  const [separator, setSeparator] = useState<TranslationSeparator>('newline');
  const [customSeparator, setCustomSeparator] = useState(' · ');
  const [order, setOrder] = useState<TranslationOrder>('source-first');
  const [rows, setRows] = useState<ReviewedUnit[]>([]);
  const [revision, setRevision] = useState('');
  const [schema, setSchema] = useState<unknown>();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [journal, setJournal] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<OfficeTranslationPreviewItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const from = direction === 'ru-en' ? 'ru' : 'en';
  const to = direction === 'ru-en' ? 'en' : 'ru';
  const active = rows.filter((row) => !row.skipped);
  const translated = active.filter((row) => row.item.targetText.trim());
  const needsReview = active.filter((row) => !row.confirmed).length;
  const staleRows = rows.filter((row) => isStale(row.unit));
  const shown = useMemo(() => rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    filter === 'review' ? !row.skipped && !row.confirmed : filter === 'stale' ? isStale(row.unit) : true), [rows, filter]);
  const sameMode = (value: TranslationMode) => value === 'new-file';

  const fail = (message: string) => { setError(message); addToast(message, 'error'); };
  const patch = (index: number, change: Partial<ReviewedUnit> | ((row: ReviewedUnit) => Partial<ReviewedUnit>)) =>
    setRows((current) => current.map((row, at) => at === index ? { ...row, ...(typeof change === 'function' ? change(row) : change) } : row));

  const read = async (keep = '') => {
    if (busy) return;
    setBusy(true); setError(''); setPreview(null); setFilter('all');
    setStatus('Читаю выбранную область…');
    try {
      const result = await bridge.read(scope, direction);
      if (!result.ok) { setRows([]); setStatus('Документ не прочитан'); fail(result.error || 'Не удалось прочитать документ'); return; }
      const units = result.units || [];
      setRevision(result.sourceRevision || ''); setSchema(result.schema); setLabels(result.displayLabels || {}); setJournal((result.records || []).length);
      setRows(units.map((unit) => ({
        unit, item: { ...unit, targetText: unit.targetText || '', confirmed: false },
        origin: unit.targetText ? 'из журнала' : 'не переведено', missing: [], confirmed: false, skipped: skippedByDefault(unit),
      })));
      const stale = units.filter(isStale).length;
      setStatus(keep || (units.length ? `Прочитано фрагментов: ${units.length}${stale ? `, устарело: ${stale}` : ''}` : 'В выбранной области нет текста для перевода'));
    } finally { setBusy(false); }
  };

  /** Переводит выбранные строки движком и памятью; остальные не трогает. */
  const translateRows = (pick: (row: ReviewedUnit) => boolean) => {
    if (busy) return;
    try {
      let count = 0;
      setRows((current) => current.map((row) => {
        if (!pick(row)) return row;
        count++;
        const segments: Segment[] = many(row.item.source, from, to);
        return {
          ...row, item: { ...row.item, targetText: joinSegments(segments) },
          origin: [...new Set(segments.map((segment) => ORIGIN_LABEL[segment.origin]))].join(', ') || 'не переведено',
          missing: [...new Set(segments.flatMap((segment) => segment.missing || []))],
          confirmed: segments.length > 0 && segments.every((segment) => segment.origin === 'tm' || segment.origin === 'kept'),
        };
      }));
      setPreview(null); setError('');
      setStatus(count ? `Перевод готов к проверке: ${count}` : 'Нет фрагментов для перевода');
    } catch (e: any) { fail(e?.message || 'Не удалось перевести текст'); }
  };

  /** «Обновить устаревшие»: остаются только они, переводятся заново и ждут подтверждения. */
  const refreshStale = () => {
    setRows((current) => current.map((row) => ({ ...row, skipped: !isStale(row.unit) })));
    setFilter('stale');
    translateRows((row) => isStale(row.unit));
  };

  const payloadOf = (override?: TranslationMode): OfficeTranslationApplyPayload => ({
    items: translated.map((row) => ({ ...row.item, confirmed: true })),
    placement: toRuntimePlacement({ mode: override || mode, scope, separator, customSeparator, order, sourceRevision: revision }),
    direction, schema, displayLabels: labels,
  });

  const showPreview = async () => {
    if (busy || !bridge.preview || !translated.length) return;
    setBusy(true); setError('');
    try {
      const result = await bridge.preview(payloadOf());
      if (!result.ok) fail(result.error || 'Предпросмотр недоступен'); else setPreview(result.items || []);
    } finally { setBusy(false); }
  };

  const apply = async (override?: TranslationMode) => {
    if (busy || bridge.readOnly || !translated.length) return;
    if (needsReview) { fail('Подтвердите или пропустите каждый непроверенный фрагмент'); return; }
    setBusy(true); setError('');
    try {
      const sent = translated.map((row) => row.item);
      const result = await bridge.apply(payloadOf(override));
      if (!result.ok) { setStatus('Перевод не записан'); fail(result.error || 'Перевод не применён'); return; }
      addToast(result.message || 'Перевод записан', 'success');
      try {
        const memory = await remember(sent.map((item) => ({ src: item.source, dst: item.targetText, from, to, docId: bridge.fileId })));
        if (!memory.ok) addToast(`Перевод записан, но память переводов не обновлена: ${memory.error || 'неизвестная ошибка'}`, 'info');
      } catch (e: any) { addToast(`Перевод записан, но память переводов не обновлена: ${e?.message || 'ошибка'}`, 'info'); }
      setBusy(false);
      await read(`Применено фрагментов: ${sent.length}`);
    } finally { setBusy(false); }
  };

  const modes = TRANSLATION_MODES[bridge.app];
  const scopes = allowedScopes(bridge.app);

  return (
    <section className="flex min-h-0 flex-col gap-3 p-3 text-slate-800 dark:text-dark-text-main" aria-label="Перевод документа">
      <div className="flex flex-col gap-3">
        <Field label="Что переводить">
          <Select value={scope} onChange={(v) => { setScope(v as TranslationScope); setRows([]); setPreview(null); }} options={scopes.map((value) => ({ value, label: scopeLabel(value) }))} />
        </Field>
        <Field label="Направление">
          <Select value={direction} onChange={(v) => { setDirection(v as TranslationLangDirection); setRows([]); }} options={[{ value: 'ru-en', label: 'Русский → английский' }, { value: 'en-ru', label: 'Английский → русский' }]} />
        </Field>
        <Field label="Куда поместить перевод">
          <Select value={mode} onChange={(v) => { setMode(v as TranslationMode); setPreview(null); }} options={modes} />
        </Field>
        {NEEDS_SEPARATOR.includes(mode) && <>
          <Field label="Разделитель"><Select value={separator} onChange={(v) => setSeparator(v as TranslationSeparator)} options={SEPARATORS} /></Field>
          {separator === 'custom' && <Field label="Свой разделитель"><Input maxLength={30} value={customSeparator} onChange={(e) => setCustomSeparator(e.target.value)} /></Field>}
          <Field label="Порядок"><Select value={order} onChange={(v) => setOrder(v as TranslationOrder)} options={[{ value: 'source-first', label: 'Оригинал, затем перевод' }, { value: 'target-first', label: 'Перевод, затем оригинал' }]} /></Field>
        </>}
      </div>

      {mode === 'replace' && <p role="status" className="fx-hint">Перед заменой рядом появится копия исходного файла. Параметры Flux и обозначения остаются связанными с оригиналом.</p>}
      {scope === 'header' && <p className="fx-hint">Переводятся только подписи шапки. Источник, поле и ключ Flux не меняются.</p>}
      {bridge.readOnly && <p role="status" className="fx-hint">Документ открыт только для просмотра: читать и переводить можно, записать нельзя.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={busy} onClick={() => void read()}>{busy && !rows.length ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Прочитать</Btn>
        <Btn disabled={busy || !active.length} onClick={() => translateRows((row) => !row.skipped)}>Перевести</Btn>
        {staleRows.length > 0 && <Btn disabled={busy} onClick={refreshStale}>Обновить устаревшие</Btn>}
      </div>

      {(status || error) && <div className="flex flex-col gap-1 border-y border-slate-200 py-2 text-xs dark:border-dark-border" aria-live="polite">
        {status && <span>{status}{journal ? ` · в журнале: ${journal}` : ''}</span>}
        {error && <span role="alert" className="text-rose-700 dark:text-rose-300">{error}</span>}
      </div>}

      {rows.length > 0 && <>
        <FilterSeg label="Показать фрагменты" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'Все', count: rows.length },
          { value: 'review', label: 'Проверить', count: needsReview },
          { value: 'stale', label: 'Устарели', count: staleRows.length },
        ]} />
        <div className="flex flex-col" aria-label="Фрагменты перевода">
          {shown.map(({ row, index }) => <TranslationRow key={`${row.item.sourceId || ''}:${row.item.key}`} row={row} index={index} total={rows.length}
            onEdit={(text) => patch(index, (r) => ({ item: { ...r.item, targetText: text }, confirmed: true }))}
            onConfirm={() => patch(index, { confirmed: true, skipped: false })} onSkip={() => patch(index, (r) => ({ skipped: !r.skipped }))} />)}
          {!shown.length && <p className="fx-hint py-2">В этом списке пока ничего нет.</p>}
        </div>
      </>}

      {preview && <div className="flex flex-col gap-1 border-t border-slate-200 pt-2 text-xs dark:border-dark-border" aria-label="Предпросмотр">
        <strong className="font-semibold">Предпросмотр · {preview.length}</strong>
        {preview.map((entry) => <div key={entry.key} className="border-b border-slate-100 pb-1 dark:border-dark-border">
          <span className="text-slate-500 dark:text-dark-text-muted">{TARGET_LABEL[entry.target]}</span>
          <div className="whitespace-pre-wrap break-words">{entry.after}</div>
        </div>)}
        {!preview.length && <span className="text-slate-500 dark:text-dark-text-muted">Редактор не вернул изменений.</span>}
      </div>}

      {rows.length > 0 && <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-white pt-2 dark:border-dark-border dark:bg-dark-bg">
        <span className="mr-auto text-xs text-slate-500 dark:text-dark-text-muted">К записи: {translated.length}{needsReview ? ` · проверить: ${needsReview}` : ''}</span>
        {bridge.preview && <Btn disabled={busy || !translated.length} onClick={() => void showPreview()}>Предпросмотр</Btn>}
        {!sameMode(mode) && <Btn disabled={busy || !translated.length || needsReview > 0 || bridge.readOnly} onClick={() => void apply('new-file')}>В новый файл</Btn>}
        <Btn tone="primary" disabled={busy || !translated.length || needsReview > 0 || bridge.readOnly} onClick={() => void apply()}>
          {busy && rows.length ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}{sameMode(mode) ? 'В новый файл' : 'Применить'}
        </Btn>
      </div>}
    </section>
  );
}
