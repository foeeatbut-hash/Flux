import React, { useState } from 'react';
import { X, Send } from 'lucide-react';
import { Z } from '../../lib/layers';
import { useEscapeClose } from '../../lib/useDismiss';
import { getMeta, submitReport } from '../../feedback/feedbackApi';
import { newRequestId } from '../../../feedback/contracts';
import { catalogDataIssueTitle, validateCatalogDataIssue, type CatalogDataIssueContext } from './dataIssue';

interface Props {
  context: CatalogDataIssueContext;
  onClose: () => void;
}

const inputClass = `w-full rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900
  px-3 py-2 text-sm text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500`;

function Label({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">{children}</span>;
}

/** Узкая форма каталога использует очередь обращений сервера и его права автора. */
export default function DataIssueDialog({ context, onClose }: Props) {
  const [description, setDescription] = useState('');
  const [proposedValue, setProposedValue] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sentNumber, setSentNumber] = useState<number | null>(null);

  useEscapeClose(true, () => { if (!sending) onClose(); });

  const send = async () => {
    const invalid = validateCatalogDataIssue(context, description, proposedValue, sourceText);
    if (invalid) { setError(invalid); return; }
    setSending(true);
    setError('');
    try {
      const meta = await getMeta();
      const report = await submitReport({
        schemaVersion: 1,
        clientRequestId: newRequestId(),
        deploymentId: meta.deploymentId,
        type: 'QUESTION',
        title: catalogDataIssueTitle(context),
        description: description.trim(),
        sectionKey: 'catalog',
        incidentAt: new Date().toISOString(),
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
        reproduction: [],
        expected: proposedValue.trim(),
        actual: context.currentValue || '',
        benefit: '',
        frequency: 'UNKNOWN',
        impact: 'NORMAL',
        uploadIds: [],
        consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
        dataIssue: {
          namespace: 'catalogDataIssue', context,
          ...(proposedValue.trim() ? { proposedValue: proposedValue.trim() } : {}),
          ...(sourceText.trim() ? { sourceText: sourceText.trim() } : {}),
        },
      } as any);
      setSentNumber(report?.number ?? 0);
    } catch (failure: any) {
      setError(failure?.message || 'Не удалось отправить сообщение');
    } finally { setSending(false); }
  };

  const current = context.currentValue?.trim() || 'Не указано';
  const sourceParts = [context.source?.file, context.source?.pages && `с. ${context.source.pages}`, context.source?.edition]
    .filter(Boolean);

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 fx-backdrop" style={{ zIndex: Z.modal }}
      onMouseDown={() => { if (!sending) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="catalog-data-issue-title"
        className="fx-dialog flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden dark:border-dark-border dark:bg-dark-surface"
        onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-dark-border">
          <h2 id="catalog-data-issue-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
            {sentNumber !== null ? 'Сообщение отправлено' : 'Сообщить о неточности'}
          </h2>
          <button type="button" onClick={onClose} disabled={sending} aria-label="Закрыть"
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </header>

        {sentNumber !== null ? (
          <div className="space-y-4 p-4">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {sentNumber ? `Обращение №${sentNumber} добавлено в очередь разбора.` : 'Обращение добавлено в очередь разбора.'}
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose}
                className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-700">Готово</button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3 overflow-y-auto p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label>Элемент</Label>
                  <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:bg-slate-900 dark:text-slate-300">
                    {context.entityTitle} <span className="text-slate-500">({context.entityId})</span>
                  </div>
                </div>
                {context.field && <div>
                  <Label>Поле</Label>
                  <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:bg-slate-900 dark:text-slate-300">{context.field}</div>
                </div>}
                <div>
                  <Label>Текущее значение</Label>
                  <div className="min-h-9 whitespace-pre-wrap break-words rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                    {current}
                  </div>
                </div>
              </div>
              {(context.revision || sourceParts.length > 0) && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {[context.revision && `Редакция ${context.revision}`, ...sourceParts].filter(Boolean).join(' · ')}
                </p>
              )}
              <label className="block">
                <Label>Что неточно</Label>
                <textarea autoFocus rows={3} maxLength={20000} value={description} onChange={(e) => setDescription(e.target.value)}
                  className={`${inputClass} resize-y`} placeholder="Опишите, что следует проверить" />
              </label>
              <label className="block">
                <Label>Предлагаемое значение <span className="text-slate-400">(необязательно)</span></Label>
                <textarea rows={2} maxLength={4000} value={proposedValue} onChange={(e) => setProposedValue(e.target.value)}
                  className={`${inputClass} resize-y`} />
              </label>
              <label className="block">
                <Label>Источник или подтверждение <span className="text-slate-400">(необязательно)</span></Label>
                <textarea rows={2} maxLength={4000} value={sourceText} onChange={(e) => setSourceText(e.target.value)}
                  className={`${inputClass} resize-y`} placeholder="Цитата, документ, ссылка на раздел или пояснение" />
              </label>
              {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
            </div>
            <footer className="flex items-center gap-2 border-t border-slate-200 px-4 py-3 dark:border-dark-border">
              <span className="flex-1 text-xs text-slate-500 dark:text-slate-400">Сообщение увидят сотрудники, разбирающие обращения.</span>
              <button type="button" onClick={onClose} disabled={sending}
                className="rounded-md px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">Отмена</button>
              <button type="button" onClick={() => void send()} disabled={sending}
                className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" />{sending ? 'Отправляем…' : 'Отправить'}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
