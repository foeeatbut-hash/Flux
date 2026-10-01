import React, { useState } from 'react';
import { BookOpenText, Clipboard, Languages, LoaderCircle, Send, Sparkles } from 'lucide-react';
import { Area, Btn, Chip, Field } from '../ui';
import { useToastStore } from '../../store/toastStore';
import { useTranslateStore } from '../../store/translateStore';
import { joinSegments } from '../../translate/engine';
import { ORIGIN_LABEL, type Segment } from '../../translate/types';

export interface TextTranslationPanelProps {
  /** Прочитать выделение или текст, доступный текущему редактору. */
  onReadText?: () => Promise<string>;
  /** Вставить результат в редактор; вызывается только по явной кнопке. */
  onInsertText?: (text: string) => Promise<void> | void;
}

export default function TextTranslationPanel({ onReadText, onInsertText }: TextTranslationPanelProps) {
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
