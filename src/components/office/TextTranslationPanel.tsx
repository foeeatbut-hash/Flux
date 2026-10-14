import React, { useState } from 'react';
import { BookOpenText, Clipboard, Languages, LoaderCircle, Send, Sparkles } from 'lucide-react';
import { Area, Btn, Chip, Field, Select } from '../ui';
import { useToastStore } from '../../store/toastStore';
import { useTranslateStore } from '../../store/translateStore';
import { joinSegments } from '../../translate/engine';
import { ORIGIN_LABEL, type Segment } from '../../translate/types';
import { TRANSLATION_MODES, allowedScopes, scopeLabel, toRuntimePlacement, type TranslationLangDirection, type TranslationMode, type TranslationScope } from '../../translate/placement';
import { useTranslationBridge, type OfficeTranslationApplyItem, type OfficeTranslationRecord } from './TranslationBridgeContext';

export interface TextTranslationPanelProps {
  /** Прочитать выделение или текст, доступный текущему редактору. */
  onReadText?: () => Promise<string>;
  /** Вставить результат в редактор; вызывается только по явной кнопке. */
  onInsertText?: (text: string) => Promise<void> | void;
}

export default function TextTranslationPanel({ onReadText, onInsertText }: TextTranslationPanelProps) {
  const officeBridge = useTranslationBridge();
  return officeBridge
    ? <OfficeTranslationPanel />
    : <LegacyTextTranslationPanel onReadText={onReadText} onInsertText={onInsertText} />;
}

function LegacyTextTranslationPanel({ onReadText, onInsertText }: TextTranslationPanelProps) {
  const many = useTranslateStore((s) => s.many);
  const addToast = useToastStore((s) => s.addToast);
  const [source, setSource] = useState('');
  const [output, setOutput] = useState('');
  const [sourceStatus, setSourceStatus] = useState('Текст не загружен');
  const [translationStatus, setTranslationStatus] = useState('Перевод не выполнен');
  const [origins, setOrigins] = useState<string[]>([]);
  const [missing, setMissing] = useState(0);
  const [busy, setBusy] = useState(false);

  const changeSource = (value: string, status = 'Изменён вручную') => {
    setSource(value);
    setSourceStatus(status);
    setOutput('');
    setTranslationStatus('Перевод не выполнен');
    setOrigins([]);
    setMissing(0);
  };

  const read = async () => {
    if (!onReadText || busy) return;
    setBusy(true);
    try {
      const text = await onReadText();
      changeSource(String(text || ''), text ? 'Текст прочитан из редактора' : 'Редактор не вернул текст');
      if (!text) addToast('В редакторе нет выбранного текста', 'info');
    } catch (e: any) {
      setSourceStatus('Не удалось прочитать текст');
      addToast(e?.message || 'Не удалось прочитать текст из редактора', 'error');
    } finally { setBusy(false); }
  };

  const translate = () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    try {
      const segments: Segment[] = many(source, 'ru', 'en');
      setOutput(joinSegments(segments));
      setMissing(segments.reduce((count, segment) => count + (segment.missing?.length || 0), 0));
      const used = [...new Set(segments.map((segment) => ORIGIN_LABEL[segment.origin]))];
      setOrigins(used);
      setTranslationStatus(segments.length ? 'Перевод готов к проверке' : 'Нет текста для перевода');
    } catch (e: any) {
      setTranslationStatus('Перевод не выполнен');
      addToast(e?.message || 'Не удалось перевести текст', 'error');
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      addToast('Результат скопирован', 'success');
    } catch { addToast('Буфер обмена недоступен', 'error'); }
  };

  const insert = async () => {
    if (!onInsertText || !output.trim() || busy) return;
    setBusy(true);
    try {
      await onInsertText(output);
      addToast('Текст вставлен в редактор', 'success');
    } catch (e: any) { addToast(e?.message || 'Не удалось вставить текст', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-3 text-slate-800 dark:text-slate-100" aria-label="Перевод текста">
      <div className="flex flex-wrap items-center gap-2">
        <Languages className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <h2 className="mr-auto text-sm font-semibold">Перевод текста · русский → английский</h2>
        {onReadText && <Btn tone="ghost" disabled={busy} onClick={() => void read()}><BookOpenText className="h-3.5 w-3.5" /> Взять из редактора</Btn>}
        <Btn tone="primary" disabled={busy || !source.trim()} onClick={translate}>
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Перевести
        </Btn>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 @[800px]:grid-cols-2">
        <Field label="Русский текст / источник" hint={sourceStatus} className="min-h-0">
          <Area value={source} onChange={(e) => changeSource(e.target.value)} className="min-h-[180px] flex-1" placeholder="Вставьте текст или прочитайте его из редактора" />
        </Field>
        <Field label="Английский текст / результат" hint={translationStatus} className="min-h-0">
          <Area value={output} onChange={(e) => setOutput(e.target.value)} className="min-h-[180px] flex-1" placeholder="Результат появится здесь; его можно исправить вручную" />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2 text-xs dark:border-slate-800">
        <span className="text-slate-500 dark:text-slate-400">Источник перевода: {origins.length ? origins.join(', ') : '—'}</span>
        <Chip tone={missing ? 'amber' : 'slate'}>не найдено слов: {missing}</Chip>
        <span className="flex-1" />
        <Btn tone="ghost" disabled={!output} onClick={() => void copy()}><Clipboard className="h-3.5 w-3.5" /> Копировать</Btn>
        {onInsertText && <Btn tone="ghost" disabled={busy || !output.trim()} onClick={() => void insert()}><Send className="h-3.5 w-3.5" /> Вставить в редактор</Btn>}
      </div>
    </section>
  );
}

interface ReviewedUnit {
  item: OfficeTranslationApplyItem;
  origin: string;
  missing: string[];
  confirmed: boolean;
}

function friendlyUnitLabel(item: OfficeTranslationApplyItem, index: number): string {
  const location = item.location as { sheetName?: unknown; address?: unknown; row?: unknown; column?: unknown; blockFrom?: unknown };
  if (typeof location.sheetName === 'string' && typeof location.address === 'string') return `${location.sheetName} · ${location.address}`;
  if (typeof location.address === 'string') return location.address;
  if (typeof location.blockFrom === 'number') return `Абзац ${index + 1}`;
  return `Фрагмент ${index + 1}`;
}

/** Перевод ячеек документа использует тот же локальный движок и память, что и обычный переводчик. */
function OfficeTranslationPanel() {
  const bridge = useTranslationBridge();
  const many = useTranslateStore((s) => s.many);
  const remember = useTranslateStore((s) => s.remember);
  const addToast = useToastStore((s) => s.addToast);
  const [scope, setScope] = useState<TranslationScope>('document');
  const [mode, setMode] = useState<TranslationMode>(bridge?.app === 'sheets' ? 'new-sheet' : 'new-file');
  const [direction, setDirection] = useState<TranslationLangDirection>('ru-en');
  const [separator, setSeparator] = useState<'newline' | 'slash' | 'dash' | 'pipe' | 'custom'>('newline');
  const [customSeparator, setCustomSeparator] = useState(' · ');
  const [order, setOrder] = useState<'source-first' | 'target-first'>('source-first');
  const [rows, setRows] = useState<ReviewedUnit[]>([]);
  const [records, setRecords] = useState<OfficeTranslationRecord[]>([]);
  const [schema, setSchema] = useState<unknown>();
  const [displayLabels, setDisplayLabels] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState('');
  const [status, setStatus] = useState('Выберите область и прочитайте документ');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const scopes = bridge ? allowedScopes(bridge.app) : ['document', 'selection', 'header'] as TranslationScope[];
  const modes = bridge ? TRANSLATION_MODES[bridge.app] : [];
  const from = direction === 'ru-en' ? 'ru' : 'en';
  const to = direction === 'ru-en' ? 'en' : 'ru';
  const reviewed = rows.filter((row) => row.confirmed || row.origin === 'из памяти' || row.origin === 'без перевода');
  const needsReview = rows.length - reviewed.length;

  const readDocument = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setRows([]);
    setRecords([]);
    setStatus('Читаю выбранную область…');
    try {
      const result = await bridge.read(scope);
      if (!result.ok) throw new Error(result.error || 'Не удалось прочитать документ');
      const units = result.units || [];
      setRevision(result.sourceRevision || '');
      setRecords(result.records || []);
      setSchema(result.schema);
      setDisplayLabels(result.displayLabels || {});
      setRows(units.map((unit) => ({
        item: { ...unit, targetText: unit.targetText || '', confirmed: false },
        origin: unit.targetText ? 'сохранённый перевод' : 'не переведено',
        missing: [], confirmed: unit.verified === true,
      })));
      setStatus(units.length ? `Прочитано фрагментов: ${units.length}` : 'В выбранной области нет текста для перевода');
      setPreview(false);
    } catch (error: any) {
      setStatus('Документ не прочитан');
      addToast(error?.message || 'Не удалось прочитать текст из редактора', 'error');
    } finally { setBusy(false); }
  };

  const translate = () => {
    if (busy || !rows.length) return;
    setBusy(true);
    try {
      const translated = rows.map(({ item }) => {
        const segments: Segment[] = many(item.source, from, to);
        return {
          item: { ...item, targetText: joinSegments(segments), confirmed: false },
          origin: [...new Set(segments.map((segment) => ORIGIN_LABEL[segment.origin]))].join(', ') || 'не переведено',
          missing: [...new Set(segments.flatMap((segment) => segment.missing || []))],
          confirmed: segments.every((segment) => segment.origin === 'tm' || segment.origin === 'kept'),
        };
      });
      setRows(translated);
      setStatus(`Перевод готов к проверке: ${translated.length} фрагментов`);
      setPreview(true);
    } catch (error: any) {
      setStatus('Перевод не выполнен');
      addToast(error?.message || 'Не удалось перевести текст', 'error');
    } finally { setBusy(false); }
  };

  const editTarget = (index: number, targetText: string) => setRows((current) => current.map((row, at) => at === index
    ? { ...row, item: { ...row.item, targetText }, confirmed: true }
    : row));
  const confirmRow = (index: number) => setRows((current) => current.map((row, at) => at === index ? { ...row, confirmed: true } : row));
  const confirmAll = () => setRows((current) => current.map((row) => ({ ...row, confirmed: true })));

  const apply = async () => {
    if (!bridge || bridge.readOnly || busy || !rows.length) return;
    if (rows.some((row) => !row.confirmed)) {
      addToast('Подтвердите каждый непроверенный фрагмент перед применением', 'error');
      return;
    }
    const placement = toRuntimePlacement({ mode, scope, separator, customSeparator, order, sourceRevision: revision });
    setBusy(true);
    try {
      if (mode === 'replace') {
        if (!bridge.saveBackup) throw new Error('Перед заменой исходника не удалось подготовить резервную копию');
        await bridge.saveBackup();
      }
      const result = await bridge.apply({
        items: rows.map((row) => ({ ...row.item, confirmed: true })), placement, direction,
        schema, displayLabels,
      });
      if (!result.ok) throw new Error(result.error || 'Перевод не применён');
      if (result.copy && bridge.saveCopy) await bridge.saveCopy(result.copy.bytes, result.copy.suggestedName || 'Перевод.docx', result.records);
      if (result.copyRequest) {
        if (!bridge.saveCopyRequest) throw new Error('Хост не умеет сохранить подготовленную копию файла');
        await bridge.saveCopyRequest(result.copyRequest, result.records);
      }
      const savedRecords = result.records || [];
      setRecords((current) => {
        const merged = new Map(current.map((record) => [`${record.sourceId}\u0000${record.key}\u0000${record.destination}\u0000${record.revision}\u0000${record.time}`, record]));
        for (const record of savedRecords) merged.set(`${record.sourceId}\u0000${record.key}\u0000${record.destination}\u0000${record.revision}\u0000${record.time}`, record);
        return [...merged.values()];
      });
      setStatus(`Применено фрагментов: ${rows.length}`);
      addToast('Перевод записан вместе с метаданными файла', 'success');
      try {
        const memory = await remember(rows.map(({ item }) => ({ src: item.source, dst: item.targetText, from, to, docId: bridge.fileId })));
        if (!memory.ok) addToast(`Файл записан, но память переводов не обновлена: ${memory.error || 'неизвестная ошибка'}`, 'info');
      } catch (error: any) {
        addToast(`Файл записан, но память переводов не обновлена: ${error?.message || 'ошибка'}`, 'info');
      }
      setPreview(false);
    } catch (error: any) {
      setStatus('Перевод не записан');
      addToast(error?.message || 'Перевод не записан; исходник не подтверждён', 'error');
    } finally { setBusy(false); }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-slate-800 dark:text-slate-100" aria-label="Перевод документа">
      <div className="flex flex-wrap items-center gap-2">
        <Languages className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <h2 className="mr-auto text-sm font-semibold">Перевод документа · локальная память и словарь</h2>
        <Btn tone="ghost" disabled={busy} onClick={() => void readDocument()}><BookOpenText className="h-3.5 w-3.5" /> Прочитать</Btn>
        <Btn tone="primary" disabled={busy || !rows.length} onClick={translate}>{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Перевести</Btn>
      </div>

      <div className="grid grid-cols-1 gap-2 @[760px]:grid-cols-2">
        <Field label="Что читать">
          <Select value={scope} onChange={(value) => { setScope(value as TranslationScope); setRows([]); setRevision(''); }} options={scopes.map((value) => ({ value, label: scopeLabel(value) }))} />
        </Field>
        <Field label="Направление">
          <Select value={direction} onChange={(value) => setDirection(value as TranslationLangDirection)} options={[{ value: 'ru-en', label: 'Русский → английский' }, { value: 'en-ru', label: 'Английский → русский' }]} />
        </Field>
        <Field label="Куда поместить перевод">
          <Select value={mode} onChange={(value) => setMode(value as TranslationMode)} options={modes} />
        </Field>
        {(mode === 'inline-before' || mode === 'inline-after' || mode === 'after-paragraph') && <>
          <Field label="Разделитель">
            <Select value={separator} onChange={(value) => setSeparator(value as typeof separator)} options={[
              { value: 'newline', label: 'Новая строка' }, { value: 'slash', label: '/' }, { value: 'dash', label: '—' },
              { value: 'pipe', label: '|' }, { value: 'custom', label: 'Свой разделитель' },
            ]} />
          </Field>
          <Field label="Порядок текста">
            <Select value={order} onChange={(value) => setOrder(value as typeof order)} options={[{ value: 'source-first', label: 'Оригинал → перевод' }, { value: 'target-first', label: 'Перевод → оригинал' }]} />
          </Field>
          {separator === 'custom' && <Field label="Свой разделитель"><Area maxLength={30} rows={1} value={customSeparator} onChange={(event) => setCustomSeparator(event.target.value)} /></Field>}
        </>}
      </div>

      {mode === 'replace' && <div role="status" className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        Перед заменой будет создана резервная копия исходного файла. Параметры Flux, ключи и технические обозначения останутся связанными с оригиналом.
      </div>}
      {scope === 'header' && <div className="rounded border border-slate-200 px-2 py-1.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
        Переводятся только отображаемые подписи. Источник, идентификатор поля и ключ Flux сохраняются без изменений.
      </div>}
      <div className="flex flex-wrap items-center gap-2 border-y border-slate-200 py-2 text-xs dark:border-slate-800">
        <span>{status}</span><span className="ml-auto">Непроверено: {needsReview}</span><span>Запомнено: {records.length}</span>
        {rows.length > 0 && <Btn tone="ghost" disabled={busy || !needsReview} onClick={confirmAll}>Подтвердить все</Btn>}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto" aria-label="Фрагменты перевода">
        {rows.map(({ item, origin, missing, confirmed }, index) => <div key={`${item.sourceId || ''}:${item.key}`} className="border-b border-slate-200 pb-2 dark:border-slate-800">
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-medium">{item.displayLabel || item.fieldKey || friendlyUnitLabel(item, index)}</span>
            <span className={confirmed ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>{confirmed ? 'Проверено' : 'Нужно проверить'}</span>
            <span className="text-slate-500 dark:text-slate-400">{origin}</span>
            {item.stale && <Chip tone="amber">Устарел</Chip>}
          </div>
          <div className="grid grid-cols-1 gap-2 @[760px]:grid-cols-2">
            <Field label="Оригинал"><Area value={item.source} readOnly rows={2} /></Field>
            <Field label="Перевод" hint={missing.length ? `Не найдены слова: ${missing.join(', ')}` : undefined}>
              <Area value={item.targetText} onChange={(event) => editTarget(index, event.target.value)} rows={2} />
            </Field>
          </div>
          {!confirmed && <Btn size="sm" tone="ghost" className="mt-1" onClick={() => confirmRow(index)}>Подтвердить этот фрагмент</Btn>}
        </div>)}
      </div>

      {preview && rows.length > 0 && <div className="border-t border-slate-200 pt-2 text-xs dark:border-slate-800" aria-live="polite">
        <strong>Предпросмотр · {rows.length} фрагментов</strong>
        <p className="mt-1 text-slate-600 dark:text-slate-300">{rows[0].item.displayLabel || rows[0].item.key}: {rows[0].item.source} → {rows[0].item.targetText}</p>
      </div>}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-2 dark:border-slate-800">
        <Btn tone="ghost" disabled={busy || !rows.length} onClick={() => setPreview((value) => !value)}>{preview ? 'Скрыть предпросмотр' : 'Предпросмотр'}</Btn>
        <Btn tone="primary" disabled={busy || !rows.length || !!bridge?.readOnly || needsReview > 0} onClick={() => void apply()}>
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Применить и записать
        </Btn>
      </div>
    </section>
  );
}
